// The one status signal of a session, shared by the Sessions side bar glyph and both node tab
// strips (canvas and tab mode), so a node never reads "done" in one place and nothing in another.
import type { AgentStatus, WsNodeKind } from '../shared/workspace'
import { sessionStatusKind, stateLabelOf, type StatusKind } from './sessionList'

export type SignalTone = StatusKind | 'unread'

export interface SessionSignal { tone: SignalTone; label: string }

/** Wording of the unread mark: a turn ended while you were not watching. */
export const UNREAD_LABEL = 'Finished — new for you'

/** Bell (your turn) and a running turn beat the unread check; otherwise unread beats done. */
export function signalOf(kind: StatusKind, unread: boolean, label: string): SessionSignal {
  if (unread && kind !== 'attention' && kind !== 'working') return { tone: 'unread', label: UNREAD_LABEL }
  return { tone: kind, label }
}

export const sessionSignal = (status: AgentStatus | undefined, unread: boolean): SessionSignal =>
  signalOf(sessionStatusKind(status), unread, stateLabelOf(status))

/** Node kinds whose tab carries a status dot. */
const DOT_KINDS: readonly WsNodeKind[] = ['agent', 'agentChat']

/** Status dot of a node tab, or undefined (not an agent kind, or nothing known yet). */
export function nodeTabSignal(kind: WsNodeKind, status: AgentStatus | undefined, unread: boolean): SessionSignal | undefined {
  if (!DOT_KINDS.includes(kind)) return undefined
  const s = sessionSignal(status, unread)
  return s.tone === 'unknown' ? undefined : s
}
