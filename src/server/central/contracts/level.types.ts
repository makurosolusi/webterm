// Cross-WS contract: control ladder, risk tiers, guard and breaker ports (RND/29 §4.3, RND/28b §4.1).
// Types and two ordered constants only; all behavior lives in WS-07.
import type { Awaitable } from './tool.types'

/** Ladder in ascending authority; index order is the comparison order for `min(...)`. */
export const CONTROL_LEVELS = ['off', 'observe', 'propose', 'act_gated', 'act_envelope'] as const

/** Persisted `central_control.level`: L0 off, L1 observe, L2 propose, L3 act_gated, L4 act_envelope. */
export type ControlLevel = (typeof CONTROL_LEVELS)[number]

/** Doc shorthand for the ladder (RND/28b §4.1), index-aligned with `CONTROL_LEVELS`. */
export type ControlLevelCode = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

/** Risk tier of a tool: R0 read, R1 bounded write, R2 shared mutation, R3 irreversible. */
export type Tier = 'R0' | 'R1' | 'R2' | 'R3'

/** Where a level is stored: `global` or `project:<id>`. */
export type ControlScope = 'global' | `project:${string}`

/** What the guard is asked to judge. */
export type GuardAction = 'tool' | 'spawn' | 'turn'

/** Input to `ControlGuard.check`. */
export interface GuardRequest {
  action: GuardAction
  projectId: string | null
  tool: string
  tier: Tier
  /** Stable digest of the proposal, for doom-loop detection. */
  digest?: string
  /** Central conversation making the call; set only on Central's own tool path, it is what taint is keyed by. */
  conversationId?: string
  /** `url` input of a browser tool, for the taint navigation rule. */
  url?: string
}

/** Why the guard refused or deferred. */
export type GuardCode =
  | 'level_denied'
  /** A persisted allow/ask/deny rule (src/server/policy) refused the capability. */
  | 'policy_denied'
  | 'halted'
  | 'project_paused'
  | 'cap_project'
  | 'cap_global'
  | 'spawn_daily'
  | 'budget_exhausted'
  | 'breaker_open'
  | 'doom_loop'
  | 'forbidden_key'
  | 'too_large'

/** `allow` runs now, `needs_approval` becomes an approval card, `deny` stops with a code. */
export type GuardDecision =
  | { verdict: 'allow'; level: ControlLevel }
  /** `tainted`: the ask is because the conversation read untrusted web content (never auto-approved by the classifier). */
  | { verdict: 'needs_approval'; level: ControlLevel; tier: Tier; tainted?: true }
  | { verdict: 'deny'; level: ControlLevel; code: GuardCode; reason: string }

/** Usage added to `central_budget` for the current UTC day. */
export interface GuardUsage {
  projectId: string | null
  turns: number
  tokens: number
  costMicros: number
  spawns: number
  wallMs: number
}

/** Breaker key: `project:<id>`, `provider:<name>` or `item:<id>`. */
export type BreakerKey = `project:${string}` | `provider:${string}` | `item:${string}`

/** Persisted breaker state. */
export type BreakerState = 'closed' | 'open' | 'half_open'

/** Answer of `BreakerPort.allow`; `retryAt` is epoch ms when state is open. */
export interface BreakerDecision {
  allowed: boolean
  state: BreakerState
  retryAt?: number
}

/** Persistent circuit breaker (survives restart). */
export interface BreakerPort {
  /** Whether a call keyed by `key` may proceed now; half_open admits one probe. */
  allow(key: BreakerKey): Awaitable<BreakerDecision>
  /** Records a failure with a stable code; opens after the threshold. */
  trip(key: BreakerKey, code: string): Awaitable<BreakerState>
  /** Records a success; closes a half_open breaker. */
  recordSuccess(key: BreakerKey): Awaitable<void>
}

/** Single server-side gate for every central effect (RND/29 §4.2 step 6). */
export interface ControlGuard {
  /** Judges one action against level, caps, budget, breaker and doom-loop. */
  check(req: GuardRequest): Awaitable<GuardDecision>
  /** `min(env ceiling, global, project)`, read fresh on every call so a lowered level applies at once. */
  effectiveLevel(projectId: string | null): Awaitable<ControlLevel>
  /** Adds usage to the daily budget. */
  recordUsage(usage: GuardUsage): Awaitable<void>
  readonly breaker: BreakerPort
  /** Danger level for the project (else the global level): asks become allows (denies stay); absent = never skips. */
  skipsApprovals?(projectId?: string | null): boolean
}
