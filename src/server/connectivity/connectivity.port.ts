// Contract of the server -> Claude API connectivity detector. Central is a Claude process, so it cannot think
// offline: the detector is deterministic server code (active probes), never an LLM and never `navigator.onLine`.
// Later waves (the work engine pausing penalties while impaired) depend on this file: keep it stable.

export type ConnState = 'online' | 'degraded' | 'offline'
/** Bounded failure class; never a URL, host, header or credential. `http` is reserved (a reachable endpoint is never a failure today). */
export type ConnCause = 'dns' | 'tcp' | 'tls' | 'timeout' | 'http' | 'unknown'
/** `network`: our own connection is down (the control probe failed too); `api`: the API/proxy is down while the network is fine. */
export type ConnScope = 'network' | 'api'

export interface ConnectivityState {
  state: ConnState
  /** Epoch ms the current state began. */
  since: number
  /** Why the last failed probe failed; absent while online. */
  cause?: ConnCause
  scope?: ConnScope
  /** Epoch ms of the last successful probe, null before the first one. */
  lastOkAt: number | null
  consecutiveFailures: number
  consecutiveSuccesses: number
}

/** One stretch spent degraded or offline; `endedAt` null = still open. */
export interface ConnectivityEpisode {
  id: string
  state: Exclude<ConnState, 'online'>
  startedAt: number
  endedAt: number | null
  durationMs: number
  cause: ConnCause | null
  scope: ConnScope | null
}

export interface ConnectivityPort {
  /** Snapshot of the current state (a copy; safe to keep). */
  state(): ConnectivityState
  /** True only for `offline` (three failed probes in a row); `degraded` is not offline. */
  isOffline(): boolean
  /** True for `offline` or `degraded`: callers pause penalties while the connection is impaired. */
  isImpaired(): boolean
  /** Calls `fn` after each state change (not each probe); returns the unsubscribe. A throwing listener is isolated. */
  subscribe(fn: (state: ConnectivityState, from: ConnState) => void): () => void
  /** Newest-first episodes, at most `limit`, each with its duration so far and its cause. */
  episodes(limit: number): ConnectivityEpisode[]
}
