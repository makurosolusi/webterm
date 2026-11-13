// The status dot of a node tab (canvas and tab mode) and of a layers row, read from the shared model
// (`sessionStatus.model.ts`), so a node never reads one thing in its tab and another in the side bar.
import type { AgentStatus, WsNodeKind } from '../shared/workspace'
import type { StatusReason } from '../shared/protocol'
import { sessionStatusView, UNREAD_LABEL, type StatusTone } from './sessionStatus.model'

export { UNREAD_LABEL }

/** A dot's tone; calm tones (idle, muted) never reach a dot. */
export type SignalTone = Exclude<StatusTone, 'idle' | 'muted'>

export interface SessionSignal { tone: SignalTone; label: string }

/** Dot of a session: needs you (attention), working, error, unread; undefined = calm, no dot. */
export function sessionSignal(status: AgentStatus | undefined, unread: boolean, reason?: StatusReason): SessionSignal | undefined {
  const v = sessionStatusView({ status, unread, ...reason })
  if (v.tone === 'idle' || v.tone === 'muted') return undefined
  return { tone: v.tone, label: v.label }
}

/** Node kinds whose tab carries a status dot. */
const DOT_KINDS: readonly WsNodeKind[] = ['agent', 'agentChat']

/** Status dot of a node tab, or undefined (not an agent kind, or calm). */
export function nodeTabSignal(kind: WsNodeKind, status: AgentStatus | undefined, unread: boolean, reason?: StatusReason): SessionSignal | undefined {
  return DOT_KINDS.includes(kind) ? sessionSignal(status, unread, reason) : undefined
}
