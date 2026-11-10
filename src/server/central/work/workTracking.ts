import type { Database } from 'bun:sqlite'
import { activeAgentChatPool } from '../../agentChat/agentChat.pool'
import { getRow } from '../../ledger/ledgerCore'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import { projectRepo } from '../../orchestratorRunProduction'
import type { PresenceTracker } from '../../channels/channelPresence'
import type { AgentState } from '../contracts'
import { projectWorkspace } from '../workspaceLookup'
import { noticeWorkMove } from '../centralNotices'
import { readAutoDone } from './workSettings'
import { createWorkStore, onWorkMove } from './workStore'
import { createWorkSupervisor, type WorkSupervisorPorts } from './workSupervisor'
import { createWorkVerifier, WORK_VERIFY_RULES, type WorkVerifierDeps } from './workVerify'
import { startWorkWatcher } from './workWatcher'

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
    input: (nodeId, text) => sessions.input(nodeId, text),
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
      const row = getRow(db, 'SELECT state, end_reason FROM central_agents WHERE id = ?', agentId)
      return row ? { state: row['state'] as AgentState, endReason: row['end_reason'] === null ? null : String(row['end_reason']) } : null
    },
  }
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
  })
  const supervisor = createWorkSupervisor({ store, ports: productionPorts(db, sessions), now })
  return {
    start() {
      verifier.recoverInterrupted()
      const unwatch = startWorkWatcher({ store, now, onReported: verifier.run, onSessionEnded: supervisor.sessionEnded })
      if (!noTimer) supervisor.start()
      return () => { unwatch(); supervisor.stop() }
    },
  }
}
