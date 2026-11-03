// Event-driven wakeup with a safety sweep (RND/28b 4.4): `wake()` coalesces bursts into one callback
// after a debounce, and a slow interval fires anyway in case a wake was lost. Truth stays in the DB.
import { createLogger } from '../logs'

const log = createLogger('central')

export const WAKE_DEBOUNCE_MS = 250
export const WAKE_SWEEP_MS = 60_000

export interface WakerDeps {
  onWake(reason: string): unknown
  debounceMs?: number
  sweepMs?: number
}

export interface Waker {
  /** Schedules one `onWake` after the debounce window; calls inside the window coalesce. No-op unless started. */
  wake(reason: string): void
  /** Arms the sweep timer. Idempotent. */
  start(): void
  /** Clears both timers and ignores later wakes (dispose). Idempotent. */
  stop(): void
  readonly running: boolean
  /** True while a debounced wake is scheduled. */
  readonly pending: boolean
}

type Timer = ReturnType<typeof setTimeout>
const unref = (timer: Timer): void => { (timer as unknown as { unref?: () => void }).unref?.() }

/** Builds the waker; timer handles are kept so `stop()` leaves nothing behind. */
export function createWaker(deps: WakerDeps): Waker {
  const debounceMs = deps.debounceMs ?? WAKE_DEBOUNCE_MS
  const sweepMs = deps.sweepMs ?? WAKE_SWEEP_MS
  let debounce: Timer | null = null
  let sweep: ReturnType<typeof setInterval> | null = null

  function fire(reason: string): void {
    try {
      const out = deps.onWake(reason)
      if (out instanceof Promise) out.catch((err: unknown) => fail(reason, err))
    } catch (err) {
      fail(reason, err)
    }
  }
  function fail(reason: string, err: unknown): void {
    log.warn('central.wake.error', 'central wake handler failed', { reason, cause: err instanceof Error ? err.name : typeof err })
  }

  return {
    wake(reason) {
      if (sweep === null || debounce !== null) return
      debounce = setTimeout(() => {
        debounce = null
        fire(reason)
      }, debounceMs)
      unref(debounce)
    },
    start() {
      if (sweep !== null) return
      sweep = setInterval(() => fire('sweep'), sweepMs)
      unref(sweep as unknown as Timer)
    },
    stop() {
      if (debounce !== null) clearTimeout(debounce)
      if (sweep !== null) clearInterval(sweep)
      debounce = null
      sweep = null
    },
    get running() { return sweep !== null },
    get pending() { return debounce !== null },
  }
}
