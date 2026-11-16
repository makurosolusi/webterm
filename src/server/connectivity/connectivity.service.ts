// The detector: probes on a timer, runs the hysteresis machine, persists episodes and announces state CHANGES.
// Timer is unref'd and never throws into the event loop; fetch, clock and randomness are injected for tests.
import type { Logger } from '../logs'
import type { ConnCause, ConnScope, ConnState, ConnectivityPort, ConnectivityState } from './connectivity.port'
import { createConnectivityMachine } from './connectivity.machine'
import { probeConnectivity, probeTarget, type FetchFn, type ProbeOutcome } from './connectivity.probe'
import type { EpisodeStore } from './connectivity.store'

// guess: retune from episode data. Spacing while online, and the Full Jitter ceiling while down.
export const PROBE_INTERVAL_MS = 15_000
export const PROBE_BACKOFF_CAP_MS = 5 * 60_000
/** Floor of the jittered delay (Full Jitter can draw ~0, which would hot-loop). */
export const PROBE_MIN_DELAY_MS = 1_000
/** After a sleep/wake gap the next probe follows quickly so recovery is not delayed by the backoff. */
export const WAKE_REPROBE_MS = 1_000
/** A tick later than this many intervals (relative to the delay we asked for) means the machine slept. */
export const WAKE_GAP_FACTOR = 2

export interface StateChange { from: ConnState; to: ConnState; state: ConnectivityState }

export interface ConnectivityService extends ConnectivityPort {
  /** One probe round (the timer calls it); resolves when the state is settled. Never rejects. */
  tick(): Promise<void>
  start(): void
  stop(): void
}

export interface ConnectivityDeps {
  fetch: FetchFn
  now: () => number
  random?: () => number
  /** Raw base URL of the provider env (re-read each tick, so a Provider card change applies); undefined = the default API. */
  baseUrl: () => string | undefined
  store: EpisodeStore
  /** Called once per state change (event + transport); a throw is logged and isolated. */
  onChange?: (change: StateChange) => void
  log: Pick<Logger, 'warn' | 'info'>
  probeTimeoutMs?: number
}

/** Full Jitter (AWS): sleep a random time in 0..min(cap, base*2^n), floored so it never spins. */
export function nextDelayMs(state: ConnectivityState, random: () => number): number {
  if (state.state === 'online' && state.consecutiveFailures === 0) return PROBE_INTERVAL_MS
  const ceiling = Math.min(PROBE_BACKOFF_CAP_MS, PROBE_INTERVAL_MS * 2 ** Math.min(state.consecutiveFailures, 10))
  return Math.max(PROBE_MIN_DELAY_MS, Math.floor(random() * ceiling))
}

export function createConnectivityService(deps: ConnectivityDeps): ConnectivityService {
  const { now, store, log } = deps
  const random = deps.random ?? Math.random
  const machine = createConnectivityMachine(now())
  const listeners = new Set<(s: ConnectivityState, from: ConnState) => void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = true
  let lastTickEnd: number | null = null
  let askedDelay = PROBE_INTERVAL_MS

  const safe = (what: string, fn: () => void): void => {
    try { fn() } catch (err) { log.warn(`connectivity.${what}.failed`, `connectivity ${what} failed`, { cause: err instanceof Error ? err.name : 'unknown' }) }
  }
  // Restart: an open episode is continued, the first probe decides whether it ends.
  safe('resume', () => {
    const open = store.open()
    if (open) machine.resume(open.state, open.startedAt, open.cause, open.scope)
  })

  const persist = (from: ConnState, to: ConnState, st: ConnectivityState, at: number): void => safe('persist', () => {
    if (from !== to) {
      if (from !== 'online') store.end(at)
      if (to !== 'online') store.begin(to, at, st.cause ?? null, st.scope ?? null)
    } else if (to !== 'online') store.annotate(st.cause ?? null, st.scope ?? null)
  })

  const outcomeOf = async (): Promise<ProbeOutcome> => {
    try { return await probeConnectivity(deps.fetch, probeTarget(deps.baseUrl()), deps.probeTimeoutMs) } catch { return { ok: false, cause: 'unknown' as ConnCause, scope: 'network' as ConnScope } }
  }

  const schedule = (ms: number): void => {
    if (stopped) return
    askedDelay = ms
    timer = setTimeout(() => { void service.tick() }, ms)
    timer.unref()
  }

  const service: ConnectivityService = {
    state: () => machine.snapshot(),
    isOffline: () => machine.snapshot().state === 'offline',
    isImpaired: () => machine.snapshot().state !== 'online',
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    episodes: (limit) => store.recent(limit, now()),
    start: () => { if (!stopped) return; stopped = false; schedule(0) },
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null },
    tick: async () => {
      if (running) return
      running = true
      try {
        const woke = lastTickEnd !== null && now() - lastTickEnd > WAKE_GAP_FACTOR * askedDelay
        if (woke) { machine.discardStreaks(); log.info('connectivity.wake', 'clock jumped; old probe results discarded') }
        const outcome = await outcomeOf()
        const at = now()
        const r = machine.apply(outcome, at)
        if (r.changed) {
          persist(r.from, r.state.state, r.state, at)
          safe('onChange', () => deps.onChange?.({ from: r.from, to: r.state.state, state: r.state }))
          for (const fn of [...listeners]) safe('listener', () => fn(r.state, r.from))
        } else if (!outcome.ok) persist(r.from, r.from, r.state, at)
        lastTickEnd = at
        schedule(woke ? WAKE_REPROBE_MS : nextDelayMs(r.state, random))
      } finally {
        running = false
      }
    },
  }
  return service
}
