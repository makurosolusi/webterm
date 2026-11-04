// Event-driven wakeup with a safety sweep (RND/28b 4.4): `wake()` coalesces bursts into one callback
// after a debounce, and a slow interval fires anyway in case a wake was lost. Truth stays in the DB.
// Senses producers (F1-d): a started waker also subscribes to the event bus, so an agent going idle
// or asking for input, a cable change, or a failed test wakes Central (PLAN rnd/04 "Indra Central").
import { eventBus, type EventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'
import { createLogger } from '../logs'

const log = createLogger('central')

export const WAKE_DEBOUNCE_MS = 250
export const WAKE_SWEEP_MS = 60_000

export interface WakerDeps {
  /** `reason` = the first reason of the window; `reasons` = every distinct reason in it (deduped). */
  onWake(reason: string, reasons: readonly string[]): unknown
  debounceMs?: number
  sweepMs?: number
  /** Event source for the Senses producers; default the process bus, `null` = none. */
  bus?: Pick<EventBus, 'subscribe'> | null
  /**
   * Trust seam. Default: only `trusted` events wake. An `untrusted` event (web/browser/unknown
   * writer) must never wake a routine at R2 or above; once routines carry a level, pass a gate
   * that admits untrusted reasons only for R0/R1 work.
   */
  allowEvent?: (event: SenseEvent, reason: string) => boolean
}

/** Bus kinds the waker listens to; `test.fail` has no producer yet (placeholder for the test runner). */
export const WAKE_EVENT_KINDS = ['hook.*', 'edge.change', 'test.fail'] as const

const NEEDS_INPUT = new Set(['agent_needs_input', 'elicitation_dialog', 'permission_prompt'])

/** Maps a Senses event to a wake reason, or null when it should not wake Central. */
export function wakeReasonFor(event: SenseEvent): string | null {
  switch (event.kind) {
    case 'edge.change': return 'edge_change'
    case 'test.fail': return 'test_fail'
    case 'hook.Stop':
    case 'hook.StopFailure': return 'agent_idle'
    case 'hook.Notification': {
      const type = (event.payload as { notificationType?: unknown } | null)?.notificationType
      if (type === 'idle_prompt') return 'agent_idle'
      return typeof type === 'string' && NEEDS_INPUT.has(type) ? 'agent_needs_input' : null
    }
    default: return null
  }
}

const trustedOnly = (event: SenseEvent): boolean => event.trust === 'trusted'

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
  let reasons = new Set<string>()
  let unsubscribe: Array<() => void> = []
  const bus = deps.bus === undefined ? eventBus : deps.bus
  const allow = deps.allowEvent ?? trustedOnly

  function fire(reason: string, all: readonly string[] = [reason]): void {
    try {
      const out = deps.onWake(reason, all)
      if (out instanceof Promise) out.catch((err: unknown) => fail(reason, err))
    } catch (err) {
      fail(reason, err)
    }
  }
  function fail(reason: string, err: unknown): void {
    log.warn('central.wake.error', 'central wake handler failed', { reason, cause: err instanceof Error ? err.name : typeof err })
  }

  function wake(reason: string): void {
    if (sweep === null) return
    reasons.add(reason)
    if (debounce !== null) return
    debounce = setTimeout(() => {
      debounce = null
      const all = [...reasons]
      reasons = new Set()
      fire(all[0] ?? reason, all)
    }, debounceMs)
    unref(debounce)
  }
  function onEvent(event: SenseEvent): void {
    const reason = wakeReasonFor(event)
    if (reason !== null && allow(event, reason)) wake(reason)
  }

  return {
    wake,
    start() {
      if (sweep !== null) return
      sweep = setInterval(() => fire('sweep'), sweepMs)
      unref(sweep as unknown as Timer)
      if (bus) unsubscribe = WAKE_EVENT_KINDS.map((kind) => bus.subscribe(kind, onEvent))
    },
    stop() {
      if (debounce !== null) clearTimeout(debounce)
      if (sweep !== null) clearInterval(sweep)
      for (const off of unsubscribe) off()
      unsubscribe = []
      reasons = new Set()
      debounce = null
      sweep = null
    },
    get running() { return sweep !== null },
    get pending() { return debounce !== null },
  }
}
