import type { AssignmentView, TaskView, WorkStatus } from '../../../shared/centralWork'
import { previewText } from '../../events/producers'
import { createLogger } from '../../logs'
import { AGENT_TERMINAL_STATES, type AgentState } from '../contracts'
import { finishTask } from './workLifecycle'
import type { WorkActor, WorkStore } from './workModel'

const log = createLogger('central.work')
const SYSTEM: WorkActor = { kind: 'system' }
const MINUTE_MS = 60_000
const TICK_INTERVAL_MS = 30_000
const TICK_LIMIT = 200
const TITLE_CHARS = 80
const TIMELINE_MAX = 500
const RESPAWN_EVENT = 'work.assignment.respawn'
const NUDGE_EVENT = 'work.assignment.nudge'
const SESSION_GONE_STATUSES: readonly WorkStatus[] = ['assigned', 'running', 'stalled', 'waiting_input']

/** Named liveness rules and their thresholds (docs/decisions/central-orchestrator.md 4C). */
export const WORK_LIVENESS_RULES = {
  startup: { name: 'startup', afterMs: 2 * MINUTE_MS },
  heartbeat: { name: 'heartbeat', afterMs: 10 * MINUTE_MS },
  stalled: { name: 'stalled', afterMs: 20 * MINUTE_MS },
  vanished: { name: 'vanished', maxRespawnsPerAssignment: 1 },
  restartLimit: { name: 'restart_limit', maxPerTask: 2, windowMs: 60 * MINUTE_MS },
} as const

/** End reason when a session died and the server has no way to relaunch it. */
export const VANISHED_NO_RESPAWN = 'vanished_no_respawn'

export type WorkSendResult = { ok: true } | { ok: false; code: string; hint?: string }

/** What the rules need from sessions, Agent Chat and the agent registry. */
export interface WorkSupervisorPorts {
  isLive(nodeId: string): boolean
  input(nodeId: string, text: string): void
  /** A chat turn is running right now. */
  chatBusy(nodeId: string): boolean
  /** The chat node is gone from its workspace. */
  chatNodeGone(assignment: AssignmentView): boolean
  /** Sends a user message; the pool reopens a closed session. */
  chatSend(assignment: AssignmentView, text: string): Promise<WorkSendResult>
  agentOf(agentId: string): { state: AgentState; endReason: string | null } | null
}

export interface WorkSupervisorDeps {
  store: WorkStore
  ports: WorkSupervisorPorts
  now(): number
  /** Runs at the end of every tick; the check-in engine lives on this one timer. */
  afterTick?(at: number): Promise<void>
}

export interface WorkSupervisor {
  tick(at?: number): Promise<void>
  /** The watcher saw a session end on an unfinished task; never rejects. */
  sessionEnded(assignment: AssignmentView, cause: string): Promise<void>
  start(): void
  stop(): void
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const terminalAgent = (state: AgentState): boolean => (AGENT_TERMINAL_STATES as readonly AgentState[]).includes(state)

/** Applies the liveness rules to open assignments; deterministic, no model is called. */
export function createWorkSupervisor({ store, ports, now, afterTick }: WorkSupervisorDeps): WorkSupervisor {
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  const agentOf = (a: AssignmentView) => (a.agentId ? ports.agentOf(a.agentId) : null)
  const titleOf = (task: TaskView): string => previewText(task.title, TITLE_CHARS) ?? task.id

  const sessionGone = (a: AssignmentView): boolean => {
    if (a.channel === 'terminal') return !ports.isLive(a.nodeId)
    if (a.channel === 'chat') return ports.chatNodeGone(a)
    if (a.channel !== 'spawn') return false
    const agent = agentOf(a)
    return !agent || terminalAgent(agent.state)
  }

  const fail = (task: TaskView, rule: string, reason: string): void => { finishTask(store, task.id, 'failed', { actor: SYSTEM, rule, reason, endReason: reason }) }

  // ponytail: scans the first TIMELINE_MAX events; a task with more than that has far bigger problems than this count.
  const respawnsInWindow = (taskId: string, at: number): number => store.timeline(taskId, { limit: TIMELINE_MAX })
    .filter((e) => e.kind === RESPAWN_EVENT && at - e.at < WORK_LIVENESS_RULES.restartLimit.windowMs).length

  const vanish = async (a: AssignmentView, task: TaskView, cause: string, at: number): Promise<void> => {
    const { vanished, restartLimit } = WORK_LIVENESS_RULES
    const agent = a.channel === 'spawn' ? agentOf(a) : null
    if (agent?.state === 'cancelled') return fail(task, vanished.name, agent.endReason ?? 'cancelled')
    // Spawn rows are terminal and terminal nodes have no server-side `--resume`: only chat can come back.
    if (a.channel !== 'chat') return fail(task, vanished.name, VANISHED_NO_RESPAWN)
    if (a.restarts >= vanished.maxRespawnsPerAssignment) return fail(task, vanished.name, 'vanished')
    if (respawnsInWindow(task.id, at) >= restartLimit.maxPerTask) return fail(task, restartLimit.name, restartLimit.name)
    store.incrementRestarts(a.id)
    store.noteAssignment(a.id, RESPAWN_EVENT, { rule: vanished.name, reason: cause })
    store.touchSignal(a.id, 'respawn', at)
    const sent = await ports.chatSend(a, `Your session was interrupted. Continue the task "${titleOf(task)}" from where you left off.`)
    if (!sent.ok) fail(task, vanished.name, `vanished: ${sent.code}`)
  }

  const nudge = async (a: AssignmentView, task: TaskView, quietMs: number, at: number): Promise<void> => {
    const minutes = Math.floor(quietMs / MINUTE_MS)
    const text = `Task "${titleOf(task)}" has been quiet for ${minutes} minutes. Please continue, or say what is blocking you.`
    try {
      if (a.channel === 'chat') {
        const sent = await ports.chatSend(a, text)
        if (!sent.ok) throw new Error(sent.code)
      } else {
        if (!ports.isLive(a.nodeId)) throw new Error('session not live')
        ports.input(a.nodeId, `${text}\r`)
      }
    } catch (err) {
      log.warn('work.nudge_failed', `nudge of task ${task.id} failed`, { taskId: task.id, assignmentId: a.id, nodeId: a.nodeId, error: errorText(err) })
      return
    }
    store.markNudged(a.id, at)
    store.noteAssignment(a.id, NUDGE_EVENT, { rule: WORK_LIVENESS_RULES.heartbeat.name, reason: `quiet for ${minutes} minutes` })
  }

  const evaluate = async (a: AssignmentView, at: number): Promise<void> => {
    const task = store.getTask(a.taskId)
    if (!task) return
    if (a.channel === 'spawn' && agentOf(a)?.state === 'approval_pending') return
    if (SESSION_GONE_STATUSES.includes(task.status) && sessionGone(a)) return vanish(a, task, 'session gone', at)
    if (a.channel === 'chat' && ports.chatBusy(a.nodeId)) return
    const { startup, heartbeat, stalled } = WORK_LIVENESS_RULES
    const since = a.lastSignalAt ?? a.startedAt
    const quiet = at - since
    if (task.status === 'assigned' && a.lastSignalAt === null && quiet >= startup.afterMs) {
      store.moveTask(task.id, 'stalled', { actor: SYSTEM, rule: startup.name, reason: 'no signal since started', assignmentId: a.id })
    } else if (task.status === 'running' && quiet >= stalled.afterMs) {
      store.moveTask(task.id, 'stalled', { actor: SYSTEM, rule: stalled.name, reason: `no signal for ${Math.floor(quiet / MINUTE_MS)} minutes`, assignmentId: a.id })
    } else if (task.status === 'running' && quiet >= heartbeat.afterMs && (a.nudgedAt === null || a.nudgedAt < since)) {
      await nudge(a, task, quiet, at)
    }
  }

  const supervisor: WorkSupervisor = {
    async tick(at = now()) {
      if (ticking) return
      ticking = true
      try {
        for (const a of store.openAssignments(TICK_LIMIT)) {
          try { await evaluate(a, at) } catch (err) {
            log.error('work.tick_row_failed', `liveness rules failed for assignment ${a.id}`, { assignmentId: a.id, taskId: a.taskId, nodeId: a.nodeId, error: errorText(err) })
          }
        }
      } catch (err) {
        log.error('work.tick_failed', 'liveness tick could not list open assignments', { error: errorText(err) })
      }
      try {
        await afterTick?.(at)
      } catch (err) {
        log.error('work.checkin_failed', `check-in pass at ${at} failed`, { at, error: errorText(err) })
      } finally {
        ticking = false
      }
    },
    async sessionEnded(a, cause) {
      try {
        const task = store.getTask(a.taskId)
        // SessionEnd fires before the PTY is gone (and on /clear, where it stays): the exit event or the tick decides.
        if (task && (a.channel === 'chat' || sessionGone(a))) await vanish(a, task, cause, now())
      } catch (err) {
        log.error('work.vanish_failed', `session end of assignment ${a.id} could not be handled`, { assignmentId: a.id, taskId: a.taskId, nodeId: a.nodeId, error: errorText(err) })
      }
    },
    start() {
      if (timer) return
      timer = setInterval(() => { void supervisor.tick() }, TICK_INTERVAL_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
  return supervisor
}
