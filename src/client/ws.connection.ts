// Connection state of the shared terminal socket (ws.ts), as a tiny external store for React.
// VS Code shows a lost/reconnecting state on the terminal instead of failing silently; this is the
// state that banner reads (TerminalCore.offline.tsx). Other callers (save queue, side sockets) use
// `whenConnected` to wait for the server instead of running their own timers.

/** First reconnect delay ceiling; doubles per failed attempt up to `RECONNECT_MAX_MS`. */
export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 10_000
/** Floor of a jittered delay, so a 0 draw never turns into a hot loop. */
export const RECONNECT_MIN_MS = 250

/**
 * `connecting` = first connect of this page; `reconnecting` = the socket dropped after it was up;
 * `offline` = the browser reports no network (retries paused until `online`); `auth` = the server
 * refused our credential (retries stopped until `retryNow()`).
 */
export type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'auth'

export interface ConnectionState {
  phase: ConnectionPhase
  /** Failed attempts since the last successful open. */
  attempt: number
  /** Epoch ms of the next reconnect attempt, while one is scheduled. */
  retryAt?: number
  /** Server process id from its `hello`; changes when the server restarts. */
  bootId?: string
  /** Server build from its `hello`. */
  build?: string
  /** Epoch ms at which this page saw a different `bootId` after a reconnect. */
  serverRestartedAt?: number
  /** The server now runs a different build than the one this page first met: reload to update. */
  buildChanged: boolean
}

let state: ConnectionState = { phase: 'connecting', attempt: 0, buildChanged: false }
const listeners = new Set<(s: ConnectionState) => void>()

/** Current connection snapshot (stable object until the next change; safe for useSyncExternalStore). */
export function getConnection(): ConnectionState {
  return state
}

/** Listen to every state change; returns unsubscribe. */
export function subscribeConnection(fn: (s: ConnectionState) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Merge `patch` into the state and notify (ws.ts only). `retryAt` is dropped unless the patch
 * carries it: it only means something while a timer is scheduled.
 */
export function setConnection(patch: Partial<ConnectionState>): void {
  state = { ...state, retryAt: undefined, ...patch }
  for (const fn of [...listeners]) fn(state)
}

/** Runs cb now if connected, else on the next transition to connected; returns cancel. */
export function whenConnected(cb: () => void): () => void {
  if (state.phase === 'connected') { cb(); return () => {} }
  const off = subscribeConnection((s) => {
    if (s.phase !== 'connected') return
    off()
    cb()
  })
  return off
}

/** Full-jitter backoff: random(0, min(capMs, baseMs * 2^attempt)), floor at minMs. */
export function reconnectDelay(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; minMs?: number; random?: () => number } = {},
): number {
  const { baseMs = RECONNECT_BASE_MS, capMs = RECONNECT_MAX_MS, minMs = RECONNECT_MIN_MS, random = Math.random } = opts
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.max(minMs, Math.floor(random() * ceiling))
}

let retryHandler: () => void = () => {}

/** ws.ts installs what "retry now" does (avoids an import cycle). */
export function setRetryHandler(fn: () => void): void {
  retryHandler = fn
}

/** Skip the backoff wait and connect now; also leaves the `auth`/`offline` stop. */
export function retryNow(): void {
  retryHandler()
}

/** Upper bound of the spread when many streams reopen together on the transition to connected. */
export const STREAM_REOPEN_JITTER_MS = 500

/**
 * Phases in which a stream (SSE) retry waits: the shared socket is the liveness signal, so while it
 * is down, lost or refused, an SSE retry would only hammer the same dead server. `connecting` does
 * not pause: it is the page's first attempt (App opens the socket at sign-in, `connectEagerly`), and
 * a stream that fails during that first second must still recover on its own backoff.
 */
const STREAM_PAUSED: ReadonlySet<ConnectionPhase> = new Set(['reconnecting', 'offline', 'auth'])

/** True while stream retries and polls should wait for the shared socket (see `STREAM_PAUSED`). */
export function streamPaused(): boolean {
  return STREAM_PAUSED.has(state.phase)
}

/**
 * Schedule one stream reopen (`fn`). While the socket is up: full-jitter backoff for `attempt`.
 * While it is paused: no timer at all; `fn` runs right after the next transition to connected,
 * spread by up to `STREAM_REOPEN_JITTER_MS` so the streams do not reopen in one burst. Returns cancel.
 */
export function scheduleStreamRetry(
  attempt: number,
  fn: () => void,
  opts: { capMs?: number; random?: () => number } = {},
): () => void {
  const random = opts.random ?? Math.random
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopWaiting = (): void => {}
  const waitForSocket = (): void => {
    stopWaiting = whenConnected(() => { arm(Math.floor(random() * STREAM_REOPEN_JITTER_MS)) })
  }
  // The phase can drop while the backoff runs: re-check when it fires instead of reopening blind.
  const arm = (ms: number): void => {
    timer = setTimeout(() => {
      timer = null
      if (streamPaused()) waitForSocket()
      else fn()
    }, ms)
  }
  if (streamPaused()) waitForSocket()
  else arm(reconnectDelay(attempt, { capMs: opts.capMs, random }))
  return () => {
    stopWaiting()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}
