// One gate for "do not punish anyone right now": the server cannot reach the Claude API (connectivity detector) or the
// API said "limit resets at T". Central and its agents cannot think then, so quiet is not a fault: leases are pushed
// out (monotonic, via the single `holdLeases` door), no rung is climbed, no check-in turn is sent, and after recovery
// everyone gets one grace cycle. Without a port and without a rate limit it does nothing (old behaviour).
import type { ConnectivityPort } from '../../connectivity/connectivity.port'
import type { WorkStore } from './workModel'
import { BOOT_GRACE_MS } from './workOwner'

/** Leases are kept this far ahead of every tick while held: two supervisor ticks (30 s each; a guess, tune from real outages). */
export const HOLD_WINDOW_MS = 60_000
/** Quiet time forgiven after the hold ends, same as after a boot. */
export const RECOVERY_GRACE_MS = BOOT_GRACE_MS
export const HOLD_EVENT = 'work.hold'

export type ConnectivityView = Pick<ConnectivityPort, 'isImpaired' | 'state'>

export interface HoldVerdict {
  /** The hold is on: nothing may be penalised or woken. */
  held: boolean
  /** Penalties may run (not held and past the recovery grace). */
  penalize: boolean
}

export interface WorkHoldDeps {
  store: Pick<WorkStore, 'holdLeases'>
  connectivity?: ConnectivityView | null
  /** Pending rate-limit reset instant (workRateLimit), null when none. */
  rateLimitResetAt?(now: number): number | null
  /** Told once per hold episode; must not throw. */
  onHold?(info: { episodeStart: number; reason: string }): void
}

export interface WorkHold {
  /** Evaluates the hold at `at` and applies it (lease push, grace, one event per episode); safe to call from several ticks. */
  check(at: number): HoldVerdict
}

/** Builds the gate shared by the supervisor tick and the check-in pass. */
export function createWorkHold({ store, connectivity, rateLimitResetAt, onHold }: WorkHoldDeps): WorkHold {
  let wasHeld = false
  let graceUntil = 0
  return {
    check(at) {
      const conn = connectivity?.isImpaired() === true ? connectivity.state() : null
      const resetAt = rateLimitResetAt?.(at) ?? null
      if (!conn && resetAt === null) {
        if (wasHeld) { wasHeld = false; graceUntil = at + RECOVERY_GRACE_MS; store.holdLeases(graceUntil) }
        return { held: false, penalize: at >= graceUntil }
      }
      store.holdLeases(Math.max(at + HOLD_WINDOW_MS, resetAt ?? 0))
      // One event per episode: only the step into the hold speaks, not each tick or each task.
      if (!wasHeld) onHold?.({ episodeStart: conn?.since ?? at, reason: conn ? `${conn.state}${conn.cause ? `:${conn.cause}` : ''}` : 'rate_limited' })
      wasHeld = true
      return { held: true, penalize: false }
    },
  }
}
