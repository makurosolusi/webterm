// Hysteresis over probe outcomes: a single blip must not flip the state either way, and flapping must not
// shake the callers. Pure (no I/O, no clock of its own): the service feeds it outcomes and timestamps.
import type { ConnCause, ConnScope, ConnState, ConnectivityState } from './connectivity.port'
import type { ProbeOutcome } from './connectivity.probe'

// guess: retune from episode data (connectivity_episode) once real outages have been recorded.
/** Consecutive failures that make the state `offline` (the first failure only makes it `degraded`). */
export const OFFLINE_AFTER_FAILURES = 3
/** Consecutive successes that make the state `online` again. */
export const ONLINE_AFTER_SUCCESSES = 2

export interface MachineApply { from: ConnState; changed: boolean; state: ConnectivityState }

export interface ConnectivityMachine {
  snapshot(): ConnectivityState
  /** Feeds one probe outcome; `changed` is true only when the state itself moved. */
  apply(outcome: ProbeOutcome, now: number): MachineApply
  /** Forgets the streak counters (after a sleep/wake gap) without touching the state. */
  discardStreaks(): void
  /** Continues from a persisted state (restart): streaks are implied by the state. */
  resume(state: Exclude<ConnState, 'online'>, since: number, cause: ConnCause | null, scope: ConnScope | null): void
}

const withoutReason = ({ cause, scope, ...rest }: ConnectivityState): ConnectivityState => (void cause, void scope, rest)

export function createConnectivityMachine(now: number): ConnectivityMachine {
  let s: ConnectivityState = { state: 'online', since: now, lastOkAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0 }
  const copy = (): ConnectivityState => ({ ...s })

  return {
    snapshot: copy,
    discardStreaks: () => { s = { ...s, consecutiveFailures: 0, consecutiveSuccesses: 0 } },
    resume: (state, since, cause, scope) => {
      s = { ...withoutReason(s), state, since, consecutiveFailures: state === 'offline' ? OFFLINE_AFTER_FAILURES : 1, consecutiveSuccesses: 0, ...(cause ? { cause } : {}), ...(scope ? { scope } : {}) }
    },
    apply: (outcome, at) => {
      const from = s.state
      let to: ConnState = from
      if (outcome.ok) {
        const successes = s.consecutiveSuccesses + 1
        s = { ...s, lastOkAt: at, consecutiveFailures: 0, consecutiveSuccesses: successes }
        if (from !== 'online' && successes >= ONLINE_AFTER_SUCCESSES) to = 'online'
      } else {
        const failures = s.consecutiveFailures + 1
        s = { ...s, consecutiveFailures: failures, consecutiveSuccesses: 0, cause: outcome.cause, scope: outcome.scope }
        to = failures >= OFFLINE_AFTER_FAILURES ? 'offline' : from === 'online' ? 'degraded' : from
      }
      if (to !== from) {
        s = { ...s, state: to, since: at }
        if (to === 'online') s = withoutReason(s)
      }
      return { from, changed: to !== from, state: copy() }
    },
  }
}
