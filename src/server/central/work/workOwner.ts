// The single owner and the lease of every open task, both derived from the status: one place decides who must act next
// and by when, so no open status can exist without either (docs/decisions/central-orchestrator.md 4C).
import type { WorkOwner, WorkStatus } from '../../../shared/centralWork'

const MINUTE_MS = 60_000

/** How long each owner has to act before the ladder escalates; `human` is also the point where the user is told. */
export const LEASE_MS = {
  /** An `assigned` agent must show a first signal. */
  agentStartup: MINUTE_MS,
  /** A `running` agent must show any signal (every hook renews it). */
  agentActive: 6 * MINUTE_MS,
  /** A reported task must be picked up by the verifier. */
  verifier: 10 * MINUTE_MS,
  /** A task waiting on Central or the user: when it runs out the user is told (the existing 15 min notice). */
  human: 15 * MINUTE_MS,
} as const

/** After a restart every open lease is held at least this long (one liveness cycle) before anyone is punished. */
export const BOOT_GRACE_MS = MINUTE_MS

const OWNER: Readonly<Partial<Record<WorkStatus, WorkOwner>>> = {
  assigned: 'agent', running: 'agent',
  stalled: 'central', failed: 'central', waiting_input: 'central',
  reported: 'verifier', verifying: 'verifier',
  needs_review: 'human',
}

/** The statuses that need an owner and a lease. */
export const OPEN_STATUSES = Object.keys(OWNER) as WorkStatus[]

/** Who must act next on a task in `status`; null for todo/blocked/done/cancelled. */
export function ownerOf(status: WorkStatus): WorkOwner | null {
  return OWNER[status] ?? null
}

const WINDOW: Readonly<Record<WorkOwner, number>> = { agent: LEASE_MS.agentActive, central: LEASE_MS.human, verifier: LEASE_MS.verifier, human: LEASE_MS.human }

/** How long the owner of `status` has from entering it; null when nobody owns it. */
export function leaseWindowOf(status: WorkStatus): number | null {
  if (status === 'assigned') return LEASE_MS.agentStartup
  const owner = ownerOf(status)
  return owner === null ? null : WINDOW[owner]
}

/** The lease a task entering `status` at `at` gets; null when nobody owns it. */
export function leaseFor(status: WorkStatus, at: number): number | null {
  const window = leaseWindowOf(status)
  return window === null ? null : at + window
}
