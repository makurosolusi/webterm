import type { Database } from 'bun:sqlite'
import { activeAgentChatPool } from '../../agentChat/agentChat.pool'
import { getRow } from '../../ledger/ledgerCore'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import { projectRepo } from '../../orchestratorRunProduction'
import type { PresenceTracker } from '../../channels/channelPresence'
import type { AgentState } from '../contracts'
import { projectWorkspace } from '../workspaceLookup'
import { noticeWorkMove } from '../centralNotices'
import { resolveChatService } from '../../centralChatHandlers'
import { appendCentralNotice } from '../chat/conversationNotice'
import { centralRuntimeKind } from '../runtime/runtimeFlag'
import { createLogger } from '../../logs'
import { createHealthReview } from '../health/healthReview'
import { healthServiceFor } from '../health/healthService'
import { createHealthStore } from '../health/healthStore'
import { onAgentEnded } from '../agents/agentStore'
import { agentNodeId } from '../agents/agentExecutor'
import { createWorkCheckin, productionCheckinSettings, type CheckinTurn } from './workCheckin'
import { setCheckinKick } from './workCheckin.kick'
import { readAutoDone } from './workSettings'
import { createWorkStore, onWorkMove } from './workStore'
import { createWorkSupervisor, type WorkSupervisorPorts } from './workSupervisor'
import { createWorkVerifier, WORK_VERIFY_RULES, type WorkVerifierDeps } from './workVerify'
import { registerWorkMemory } from './workMemory'
import { startWorkWatcher } from './workWatcher'
import { automaticAction } from '../automaticAction'
import { announceAutoDone } from './workAutoDoneOffer'
import { AGENT_REPORT_RULE, EXEC_EXIT_RULE } from './workLifecycle'
import type { WorkMove } from './workModel'

const log = createLogger('central.work')

export interface WorkTrackingDeps {
  db: Database
  sessions: WorkerSessionPort
  now(): number
  noTimer: boolean
  /** Test seam: the verification check (default: the project's real checks). */
  check?: WorkVerifierDeps['check']
  /** Test seam: who is looking (default: the process-wide tracker). */
  presence?: PresenceTracker
}

function productionPorts(db: Database, sessions: WorkerSessionPort): WorkSupervisorPorts {
  return {
    isLive: (nodeId) => sessions.isLive(nodeId),
    submit: (nodeId, text) => sessions.submit(nodeId, text),
    chatBusy: (nodeId) => activeAgentChatPool()?.peek(nodeId)?.busy() === true,
    chatNodeGone: (a) => {
      const ws = projectWorkspace(db, a.projectId)
      if (ws.ok) return !ws.nodes.some((n) => (n as { id?: unknown }).id === a.nodeId)
      return ws.code === 'workspace_not_found'
    },
    chatSend: async (a, text) => {
      const ws = projectWorkspace(db, a.projectId)
      if (!ws.ok) return { ok: false, code: ws.code }
      return (await import('../../agentChat/agentChat.runtime')).agentChatPort().send(ws.workspaceId, a.nodeId, text)
    },
    agentOf: (agentId) => {
      const row = getRow(db, 'SELECT state, end_reason, last_event_at FROM central_agents WHERE id = ?', agentId)
      return row ? { state: row['state'] as AgentState, endReason: row['end_reason'] === null ? null : String(row['end_reason']), lastEventAt: row['last_event_at'] === null ? null : Number(row['last_event_at']) } : null
    },
  }
}

function startCheckinTurn(db: Database): (turn: CheckinTurn) => string {
  return (turn) => {
    const { response, done } = resolveChatService({}, db, centralRuntimeKind()).service.submit(turn)
    done.catch((err: unknown) => log.warn('work.checkin_turn_failed', `check-in turn ${response.turnId} did not finish`, { turnId: response.turnId, error: err instanceof Error ? err.message : String(err) }))
    return response.turnId
  }
}

/** The auto-done notice and record, with Reopen as its undo. */
export function announceAutoDoneMove(db: Database, move: WorkMove, now: () => number): void {
  if (move.to !== 'done' || move.rule !== WORK_VERIFY_RULES.autoDone) return
  const { task } = move
  automaticAction({ db, now }, {
    name: 'auto_done', actor: 'system:work', subject: `task:${task.id}`, projectId: task.projectId, noticeKey: `auto:auto_done:${task.id}:${move.seq}`,
    text: `Marked "${task.title}" done automatically: its check passed.`,
    undo: { label: 'Reopen', method: 'POST', path: `/api/central/tasks/${encodeURIComponent(task.id)}/reopen` },
  })
}

/** One per process: the verifier outlives a pause, so a bounce can tell a running verification from an orphaned one. */
export function createWorkTracking({ db, sessions, now, noTimer, check, presence }: WorkTrackingDeps): { start(): () => void } {
  const store = createWorkStore(db, now)
  const autoDone = (projectId: string): boolean => readAutoDone(db, projectId) === true
  const verifier = createWorkVerifier({ store, now, cwdOf: (projectId) => projectRepo(db, projectId), autoDone, ...(check ? { check } : {}) })
  onWorkMove(db, (move) => {
    // A task that passed on an auto-done project is done a moment later: nothing to review, so nothing to announce.
    if (move.rule === WORK_VERIFY_RULES.passed && autoDone(move.task.projectId)) return
    noticeWorkMove(db, move, { now, ...(presence ? { presence } : {}) })
    announceAutoDoneMove(db, move, now)
  })
  // A report (`webterm report --done`) or a headless exit reaches `reported` outside the hook watcher: verify it the same way.
  onWorkMove(db, (move) => {
    if (move.to === 'reported' && (move.rule === AGENT_REPORT_RULE || move.rule === EXEC_EXIT_RULE)) queueMicrotask(() => { void verifier.run(move.task.id) })
  })
  registerWorkMemory(db, now)
  const checkin = createWorkCheckin({
    db, store, now, settings: productionCheckinSettings, submit: startCheckinTurn(db),
    notice: (key, text, conversationId) => appendCentralNotice(db, { key, text, conversationId, now }),
  })
  // A reason due now (delegated work reported, failed, needs input) runs the check-in pass at once instead of on the next 30 s tick
  // (off with the timers: the pass reads the production settings row).
  let kick: ReturnType<typeof setTimeout> | null = null
  onWorkMove(db, (move) => {
    if (!checkin.onMove(move) || kick || noTimer) return
    kick = setTimeout(() => {
      kick = null
      checkin.tick().catch((err: unknown) => log.error('work.checkin_failed', `immediate check-in after task ${move.task.id} moved to ${move.to} failed`, { taskId: move.task.id, error: err instanceof Error ? err.message : String(err) }))
    }, 0)
  })
  const cwdOf = (projectId: string): string | null => projectRepo(db, projectId)
  onWorkMove(db, createHealthReview({ db, store: createHealthStore(db, now), now, cwdOf }).onMove)
  const health = healthServiceFor(db, now)
  const afterTick = async (at: number): Promise<void> => {
    // Beside the check-in pass, not before it: a scan takes seconds and must not hold the liveness tick; it never throws.
    void health.autoScanDue(at)
    try {
      announceAutoDone(db, now) // a project created since the last pass gets its auto-done notice
    } catch (err) {
      log.warn('work.auto_done_offer_failed', 'auto-done offer pass failed', { error: err instanceof Error ? err.message : String(err) })
    }
    await checkin.tick(at)
  }
  const supervisor = createWorkSupervisor({
    store, ports: productionPorts(db, sessions), now, afterTick,
    announce: ({ name, text, key, task, nodeId }) => { automaticAction({ db, now }, { name, text, noticeKey: key, actor: 'system:work', subject: `task:${task.id}`, projectId: task.projectId, nodeId }) },
  })
  return {
    start() {
      verifier.recoverInterrupted()
      const unwatch = startWorkWatcher({ store, now, onReported: verifier.run, onSessionEnded: supervisor.sessionEnded })
      // An agent that exited, failed to spawn or was cancelled settles its task now (failed + wake), not on the next tick.
      const unAgents = onAgentEnded(db, (agent) => {
        const a = store.openAssignmentOfNode(agent.nodeId ?? agentNodeId(agent.id))
        if (a?.agentId === agent.id) queueMicrotask(() => { void supervisor.sessionEnded(a, `agent_${agent.state}`) })
      })
      if (!noTimer) {
        supervisor.start()
        // A held permission prompt waits on Central: its reason runs the pass now, not on the next tick.
        setCheckinKick(() => { checkin.tick().catch((err: unknown) => log.error('work.checkin_failed', 'immediate check-in for a permission prompt failed', { error: err instanceof Error ? err.message : String(err) })) })
      }
      return () => { unwatch(); unAgents(); supervisor.stop(); setCheckinKick(null) }
    },
  }
}
