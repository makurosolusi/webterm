import type { AssignmentView, WorkStatus } from '../../../shared/centralWork'
import { type EventBus, eventBus } from '../../events/eventBus'
import type { SenseEvent } from '../../events/eventModel'
import { createLogger } from '../../logs'
import type { WorkActor, WorkStore } from './workModel'
import { noResult, takeStopResult } from './workResult'

const log = createLogger('central.work')
const SYSTEM: WorkActor = { kind: 'system' }
const NEEDS_INPUT = new Set(['agent_needs_input', 'elicitation_dialog', 'permission_prompt'])
const SESSION_END_RULE = 'session_end'
const REVIEWABLE: readonly WorkStatus[] = ['reported', 'verifying', 'needs_review']
const INTERRUPTIBLE: readonly WorkStatus[] = ['assigned', 'running', 'stalled', 'waiting_input']

/** `activity` only proves the agent is alive (a subagent's tool use): it touches the signal, never the status. */
type Signal = 'busy' | 'stop' | 'failure' | 'input' | 'end' | 'activity'
interface Move { from: readonly WorkStatus[]; to: WorkStatus; rule: string }

/** The named rule behind every status change a signal can cause. */
export const WORK_SIGNAL_MOVES: Readonly<Record<Exclude<Signal, 'end' | 'activity'>, Move>> = {
  busy: { from: ['assigned', 'stalled', 'waiting_input', 'reported', 'needs_review', 'verifying'], to: 'running', rule: 'activity' },
  // Stalled counts too: an agent that went quiet and then finished must not stay stalled forever.
  stop: { from: ['running', 'stalled'], to: 'reported', rule: 'stop_without_report' },
  failure: { from: ['running'], to: 'stalled', rule: 'stop_failure' },
  input: { from: ['running', 'assigned'], to: 'waiting_input', rule: 'needs_input' },
}

function signalOf(event: SenseEvent): Signal | null {
  const payload = (event.payload ?? {}) as { notificationType?: unknown; subagent?: unknown; outcome?: unknown }
  switch (event.kind) {
    case 'hook.UserPromptSubmit':
    case 'agentChat.turn_start': return 'busy'
    // A subagent's tool use can land after its parent stopped: it proves life (a long subagent run is not a stall) but moves nothing.
    case 'hook.PreToolUse':
    case 'hook.PostToolUse': return payload.subagent ? 'activity' : 'busy'
    case 'hook.Stop': return 'stop'
    case 'hook.StopFailure': return 'failure'
    case 'agentChat.turn_end': return payload.outcome === 'ok' ? 'stop' : 'failure'
    case 'hook.PermissionRequest':
    case 'agentChat.needs_input': return 'input'
    // idle_prompt and the like mean the agent sits idle, so they prove nothing.
    case 'hook.Notification': return NEEDS_INPUT.has(String(payload.notificationType)) ? 'input' : null
    case 'hook.SessionEnd':
    case 'pty.exit':
    case 'agentChat.closed': return 'end'
    default: return null
  }
}

export interface WorkWatcherDeps {
  store: WorkStore
  now(): number
  bus?: EventBus
  /** A task just reached `reported`; must not reject. */
  onReported(taskId: string): unknown
  /** The session of an unfinished task ended; must not reject. */
  onSessionEnded(assignment: AssignmentView, cause: string): unknown
}

/** Subscribes to agent signals and moves open assignments' tasks; returns the unsubscribe function. */
export function startWorkWatcher({ store, now, bus = eventBus, onReported, onSessionEnded }: WorkWatcherDeps): () => void {
  const apply = (nodeId: string, event: SenseEvent, signal: Signal): void => {
    const assignment = store.openAssignmentOfNode(nodeId)
    if (!assignment || !store.touchSignal(assignment.id, event.kind, now())) return
    const task = store.getTask(assignment.taskId)
    if (!task) return
    if (signal === 'activity') return
    if (signal === 'end') {
      if (REVIEWABLE.includes(task.status)) store.endAssignment(assignment.id, SESSION_END_RULE, undefined, { actor: SYSTEM, rule: SESSION_END_RULE })
      else if (INTERRUPTIBLE.includes(task.status)) onSessionEnded(assignment, event.kind)
      return
    }
    const move = WORK_SIGNAL_MOVES[signal]
    // A Stop that lands after `webterm report --done` already moved the task: its richer capture still replaces the report text.
    if (signal === 'stop' && REVIEWABLE.includes(task.status)) {
      const late = takeStopResult(nodeId)
      if (late) store.recordResult(assignment.id, late)
      return
    }
    if (!move.from.includes(task.status)) return
    const options = { actor: SYSTEM, rule: move.rule, reason: event.kind, assignmentId: assignment.id }
    if (signal === 'input' && task.status === 'assigned') store.moveTask(task.id, 'running', options)
    // The result is written BEFORE the move: a `reported` task never exists without one (text, or `none` + reason).
    // Only Stop/StopFailure park a capture; another channel (chat turn end) leaves none, which is recorded as such.
    if (signal === 'stop' || signal === 'failure') {
      const captured = event.kind.startsWith('hook.') ? takeStopResult(nodeId) : undefined
      store.recordResult(assignment.id, captured ?? noResult(`no_hook_payload:${event.kind}`, now()))
    }
    store.moveTask(task.id, move.to, options)
    if (move.to === 'reported') onReported(task.id)
  }
  // A subscriber that throws is removed from the bus, which would silently end all work tracking.
  const onEvent = (event: SenseEvent): void => {
    if (event.trust !== 'trusted' || !event.nodeId) return
    const signal = signalOf(event)
    if (!signal) return
    try { apply(event.nodeId, event, signal) } catch (err) {
      log.error('work.watch_failed', `work watcher could not apply ${event.kind} to node ${event.nodeId}`, { ids: { nodeId: event.nodeId }, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const offs = ['hook.*', 'pty.exit', 'agentChat.*'].map((pattern) => bus.subscribe(pattern, onEvent))
  return () => offs.forEach((off) => off())
}
