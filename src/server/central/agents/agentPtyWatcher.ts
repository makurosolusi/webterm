// Moves live PTY workers along the state machine from Claude Code hook signals and PTY exits,
// the counterpart of the exec runner's `onExit` for rows with runner 'pty'.
import type { Database } from 'bun:sqlite'
import { type EventBus, eventBus } from '../../events/eventBus'
import type { SenseEvent } from '../../events/eventModel'
import { getRow } from '../../ledger/ledgerCore'
import { appendEvent } from '../../ledger/ledgerEvent'
import { createLogger } from '../../logs'
import { AGENT_TERMINAL_STATES, type AgentState } from '../contracts'
import { canTransition } from './agentStateMachine'
import type { AgentStore } from './agentStore'

const log = createLogger('central.agents')
const ENDED = AGENT_TERMINAL_STATES.map(() => '?').join(',')
const NEEDS_INPUT = new Set(['agent_needs_input', 'elicitation_dialog', 'permission_prompt'])

/** `from` absent = any state with an edge to `to`. */
interface Move { from?: readonly AgentState[]; to: AgentState; reason?: string }

const INPUT: Move = { from: ['working'], to: 'waiting_input' }
const BUSY: Move = { from: ['waiting_input', 'candidate_done'], to: 'working' }

function moveFor(event: SenseEvent): Move | null {
  const payload = (event.payload ?? {}) as { notificationType?: unknown; subagent?: unknown }
  switch (event.kind) {
    case 'hook.Stop': return { from: ['working'], to: 'candidate_done' }
    case 'hook.StopFailure': return { ...INPUT, reason: 'stop_failure' }
    case 'hook.PermissionRequest': return INPUT
    case 'hook.Notification': return NEEDS_INPUT.has(String(payload.notificationType)) ? INPUT : null
    case 'hook.UserPromptSubmit': return BUSY
    // A subagent's tool use can land after its parent stopped; only the parent's own may wake the row.
    case 'hook.PreToolUse':
    case 'hook.PostToolUse': return payload.subagent ? null : BUSY
    case 'hook.SessionEnd': return { to: 'session_exited', reason: 'session_end' }
    case 'pty.exit': return { to: 'session_exited', reason: 'pty_exit' }
    default: return null
  }
}

export interface AgentPtyWatcherDeps {
  db: Database
  store: AgentStore
  now(): number
  bus?: EventBus
}

/** Subscribes to hook and PTY-exit events; returns the unsubscribe function. */
export function startAgentPtyWatcher({ db, store, now, bus = eventBus }: AgentPtyWatcherDeps): () => void {
  const apply = (nodeId: string, event: SenseEvent, move: Move): void => {
    const row = getRow(db, `SELECT id FROM central_agents WHERE runner = 'pty' AND state NOT IN (${ENDED}) AND (node_id = ? OR 'c-' || id = ?) LIMIT 1`, ...AGENT_TERMINAL_STATES, nodeId, nodeId)
    const agent = row ? store.get(String(row['id'])) : null
    if (!agent || (move.from && !move.from.includes(agent.state)) || !canTransition(agent.state, move.to)) return
    const moved = store.transition(agent.id, move.to, { ...(move.reason ? { reason: move.reason } : {}), ...(agent.fence !== null ? { fence: agent.fence } : {}) })
    appendEvent({ db, now }, { kind: 'central.agent', actor: 'central', projectId: moved.projectId, payload: { phase: `pty.${move.to}`, agentId: moved.id, nodeId, from: agent.state, event: event.kind, ...(move.reason ? { reason: move.reason } : {}) } })
  }
  // A subscriber that throws is removed from the bus, which would silently end all PTY tracking.
  const onEvent = (event: SenseEvent): void => {
    if (event.trust !== 'trusted' || !event.nodeId) return
    const move = moveFor(event)
    if (!move) return
    try { apply(event.nodeId, event, move) } catch (err) {
      log.error('agent.pty_watch_failed', `pty watcher could not apply ${event.kind} to node ${event.nodeId}`, { ids: { nodeId: event.nodeId }, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const offs = [bus.subscribe('hook.*', onEvent), bus.subscribe('pty.exit', onEvent)]
  return () => offs.forEach((off) => off())
}
