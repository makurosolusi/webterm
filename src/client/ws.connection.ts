// Connection state of the shared terminal socket (ws.ts), as a tiny external store for React.
// VS Code shows a lost/reconnecting state on the terminal instead of failing silently; this is the
// state that banner reads (TerminalCore.offline.tsx).

/** First reconnect delay; doubles per failed attempt up to `RECONNECT_MAX_MS`. */
export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 10_000

export interface ConnectionState {
  /** `connecting` = first connect of this page; `reconnecting` = the socket dropped after it was up. */
  phase: 'connecting' | 'connected' | 'reconnecting'
  /** Epoch ms of the next reconnect attempt, while one is scheduled. */
  retryAt?: number
}

let state: ConnectionState = { phase: 'connecting' }
const listeners = new Set<() => void>()

export function getConnection(): ConnectionState {
  return state
}

export function subscribeConnection(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setConnection(next: ConnectionState): void {
  state = next
  for (const cb of [...listeners]) cb()
}

/** Delay before reconnect attempt number `attempt` (0-based). */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
}
