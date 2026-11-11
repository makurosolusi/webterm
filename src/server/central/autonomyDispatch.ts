// Non-blocking dispatcher for the central autonomy loop (RND/28b 4.3 #3-#4). A tick only picks and
// registers a job; the worker runs in the background as a tracked promise, bounded by
// `maxInflight`, and a persistent per-item breaker stops a doom-loop (same failure root, repeated).
import { flagOn } from '../envFlag'
import { createLogger } from '../logs'
import type { SyncBreaker } from './guard/breakerStore'

const log = createLogger('central')

/** `WEBTERM_CENTRAL_RELIABILITY=on` switches autonomy to dispatch/wake/breaker mode; anything else keeps the legacy loop. */
export const RELIABILITY_ENV = 'WEBTERM_CENTRAL_RELIABILITY'
/** Optional override of the global worker cap, re-read on every dispatch (Settings edit process.env). */
export const MAX_INFLIGHT_ENV = 'WEBTERM_CENTRAL_MAX_INFLIGHT'
/** Global cap of workers started by autonomy at once (the 3-per-project cap lives in `caps.ts`). */
export const DEFAULT_MAX_INFLIGHT_WORKERS = 3
const FALLBACK_CODE = 'run_failed'

/** True only for the literal `on`. */
export function reliabilityEnabled(raw: string | undefined = process.env[RELIABILITY_ENV]): boolean {
  return flagOn(raw)
}

/** Positive integer from env, else the default; garbage never lowers the cap to zero. */
export function maxInflightFromEnv(raw: string | undefined = process.env[MAX_INFLIGHT_ENV]): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_INFLIGHT_WORKERS
}

export interface DispatchJob { projectId: string; itemId: string }
export interface DispatchResult { ok: boolean; code?: string }
export type StartResult = 'started' | 'saturated' | 'duplicate' | 'breaker_open'

export interface DispatcherDeps {
  /** Global cap; a function is re-read on every `start`, so a lowered cap only blocks new jobs. */
  maxInflight?: number | (() => number)
  /** Persistent breaker (WS-07); keyed `item:<projectId>:<itemId>`. Absent = no breaker. */
  breaker?: SyncBreaker
  /** Called once per job when its worker promise settles; `breakerOpened` marks a doom-loop trip. */
  onSettled(job: DispatchJob, result: DispatchResult, breakerOpened: boolean): void
}

export interface Dispatcher {
  /** Registers and launches `exec` in the background; never awaits it. */
  start(job: DispatchJob, exec: () => Promise<DispatchResult>): StartResult
  has(job: DispatchJob): boolean
  readonly size: number
  readonly capacity: number
  /** Resolves when every worker in flight has settled (shutdown/tests). */
  drain(): Promise<void>
}

const jobKey = (job: DispatchJob): string => `${job.projectId}:${job.itemId}`

/** Trips the item breaker; a different failure root restarts the count. True when it is now open. */
function tripItem(breaker: SyncBreaker, key: `item:${string}`, code: string): boolean {
  const row = breaker.peek(key)
  if (row && row.state === 'closed' && row.failures > 0 && row.lastCode !== code) breaker.recordSuccess(key)
  return breaker.trip(key, code) === 'open'
}

/** Builds the bounded, breaker-aware dispatcher. */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const capacity = (): number => {
    const cap = typeof deps.maxInflight === 'function' ? deps.maxInflight() : deps.maxInflight
    return Math.max(1, cap ?? DEFAULT_MAX_INFLIGHT_WORKERS)
  }
  const inflight = new Map<string, Promise<void>>()

  function settle(job: DispatchJob, result: DispatchResult): void {
    inflight.delete(jobKey(job))
    let opened = false
    if (deps.breaker) {
      const key: `item:${string}` = `item:${jobKey(job)}`
      try {
        if (result.ok) deps.breaker.recordSuccess(key)
        else opened = tripItem(deps.breaker, key, result.code ?? FALLBACK_CODE)
      } catch (err) {
        log.warn('central.dispatch.breaker_failed', 'central dispatch: breaker write failed', { projectId: job.projectId, reason: err instanceof Error ? err.name : typeof err })
      }
    }
    try {
      deps.onSettled(job, result, opened)
    } catch (err) {
      log.warn('central.dispatch.settle_failed', 'central dispatch: settle handler failed', { projectId: job.projectId, reason: err instanceof Error ? err.name : typeof err })
    }
  }

  return {
    start(job, exec) {
      const key = jobKey(job)
      if (inflight.has(key)) return 'duplicate'
      if (inflight.size >= capacity()) return 'saturated'
      if (deps.breaker && !deps.breaker.allow(`item:${key}`).allowed) return 'breaker_open'
      const promise = Promise.resolve()
        .then(exec)
        .catch((): DispatchResult => ({ ok: false, code: 'internal' }))
        .then((result) => settle(job, result))
      inflight.set(key, promise)
      return 'started'
    },
    has: (job) => inflight.has(jobKey(job)),
    get size() { return inflight.size },
    get capacity() { return capacity() },
    async drain() {
      while (inflight.size > 0) await Promise.all([...inflight.values()])
    },
  }
}
