// Model ladder (Claude-only): which model + effort a call runs on. Pure: no I/O, no clock.
// Each call kind starts on a tier, a failed attempt may climb at most LADDER_LIMITS.maxSteps rungs
// (never above T3 on its own), budget pressure pulls the tier down, and a user override always wins.

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'
export type LadderModel = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CallKind = 'helper' | 'explore' | 'central' | 'dag-planner' | 'dag-worker' | 'routine' | 'prreview' | 'bakeoff' | 'agent-spawn'

/** `model`/`effort` null = leave it to the CLI default (T0). `reason` is a short English string for logs/UI. */
export interface ModelPick {
  model: LadderModel | null; effort: Effort | null; tier: Tier; reason: string
  /** True when Fable was asked for without a human grant and the pick fell back to Opus. */
  fableBlocked?: boolean
  /** Whether the caller's scope holds a Fable grant (agent chat re-checks an explicit per-node model against it). */
  fableGranted?: boolean
}

export interface ResolveInput {
  kind: CallKind
  /** Starting tier; defaults to `defaultTier(kind, complexity)`. */
  tier?: Tier
  complexity?: 'simple' | 'moderate' | 'complex'
  /** 0-based index of the attempt being resolved (0 = first try); each earlier attempt failed with `lastFailure`. */
  attempt?: number
  lastFailure?: 'verify_failed' | 'no_changes' | 'timeout' | 'lease_violation' | 'policy_denied' | null
  override?: { model?: string; effort?: Effort } | null
  spentMicros?: number
  capMicros?: number
  /** A human granted Fable for this scope (see fableGrant.ts). Absent = no grant: Fable resolves to Opus. */
  fableGranted?: boolean
}

export const TIER_TABLE: Readonly<Record<Tier, { model: LadderModel | null; effort: Effort | null }>> = Object.freeze({
  T0: { model: null, effort: null },
  T1: { model: 'haiku', effort: 'low' },
  T2: { model: 'sonnet', effort: 'medium' },
  T3: { model: 'opus', effort: 'high' },
  T4: { model: 'fable', effort: 'xhigh' },
})

export const LADDER_LIMITS: { maxSteps: 2; maxAutoTier: 'T3'; downgradeAtFraction: 0.8; hardAtFraction: 1 } =
  Object.freeze({ maxSteps: 2, maxAutoTier: 'T3', downgradeAtFraction: 0.8, hardAtFraction: 1 })

/** Full model id per alias, for display and for CLIs that want an exact id. */
export const MODEL_IDS: Readonly<Record<LadderModel, string>> = Object.freeze({
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
})

const TIERS: readonly Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Highest effort a timeout may raise to on its own; `max` is only reachable by override. */
const MAX_AUTO_EFFORT: Effort = 'xhigh'

const rank = (t: Tier): number => TIERS.indexOf(t)

/** The next effort up for a timeout retry (low→medium→high→xhigh), or null at xhigh/max. */
export function effortLadder(effort: Effort): Effort | null {
  const i = EFFORTS.indexOf(effort)
  return i < EFFORTS.indexOf(MAX_AUTO_EFFORT) ? EFFORTS[i + 1]! : null
}

export function defaultTier(kind: CallKind, complexity?: ResolveInput['complexity']): Tier {
  switch (kind) {
    case 'helper': case 'explore': return 'T1'
    case 'dag-planner': return 'T3'
    case 'dag-worker': return complexity === 'complex' ? 'T3' : 'T2'
    // Central states how hard the worker's task is; no hint = the routine default. Never above T3 (T4 is a human grant).
    case 'agent-spawn': return complexity === 'simple' ? 'T1' : complexity === 'complex' ? 'T3' : 'T2'
    default: return 'T2' // central, routine, prreview, bakeoff
  }
}

/**
 * One escalation after a failed attempt; `attempt` = escalations already taken. Null = stay put:
 * the failure does not warrant it (lease/policy), the step budget is spent, or the next rung is above T3.
 */
export function nextStep(tier: Tier, effort: Effort, failure: ResolveInput['lastFailure'], attempt: number): { tier: Tier; effort: Effort } | null {
  if (attempt >= LADDER_LIMITS.maxSteps) return null
  if (failure !== 'verify_failed' && failure !== 'no_changes' && failure !== 'timeout') return null
  if (failure === 'timeout' && tier !== 'T0') {
    const up = effortLadder(effort)
    if (up) return { tier, effort: up }
  }
  const next = TIERS[rank(tier) + 1]
  if (!next || rank(next) > rank(LADDER_LIMITS.maxAutoTier)) return null
  return { tier: next, effort: TIER_TABLE[next].effort! }
}

/** Alias or full id (any Claude id naming the family) → ladder alias; null when it names none. */
function aliasOf(model: string): LadderModel | null {
  const m = model.toLowerCase()
  return (Object.keys(MODEL_IDS) as LadderModel[]).find((a) => m === a || m.includes(a)) ?? null
}

/** Reason shown to the user when Fable is requested without a grant. */
export const FABLE_NEEDS_APPROVAL = 'Fable needs approval; running on Opus'

/** True when `model` (alias or full id) names the Fable family. */
export const isFableModel = (model: string | null | undefined): boolean => !!model && aliasOf(model) === 'fable'

/** Every path that ends on Fable (override, /model, projectModels, ladder T4) passes here: no grant = Opus. */
export function resolveModel(input: ResolveInput): ModelPick {
  const pick = resolveUngated(input)
  if (input.fableGranted) return { ...pick, fableGranted: true }
  if (pick.model !== 'fable') return pick
  const effort = input.override?.effort ?? TIER_TABLE.T3.effort
  return { model: 'opus', effort, tier: 'T3', reason: FABLE_NEEDS_APPROVAL, fableBlocked: true }
}

function resolveUngated(input: ResolveInput): ModelPick {
  const base = input.tier ?? defaultTier(input.kind, input.complexity)
  const o = input.override
  if (o && (o.model || o.effort)) {
    const model = o.model ? aliasOf(o.model) : TIER_TABLE[base].model
    const tier = o.model ? (TIERS.find((t) => TIER_TABLE[t].model === model) ?? base) : base
    return { model, effort: o.effort ?? TIER_TABLE[tier].effort, tier, reason: 'user override' }
  }

  let tier = base
  let effort = TIER_TABLE[base].effort
  let steps = 0
  for (let i = 0; i < (input.attempt ?? 0); i++) {
    const step = nextStep(tier, effort ?? 'low', input.lastFailure ?? null, i)
    if (!step) break
    tier = step.tier
    effort = step.effort
    steps++
  }
  let reason = steps > 0 ? `escalated ${steps} step(s) after ${input.lastFailure}` : `default for ${input.kind}`

  const cap = input.capMicros ?? 0
  const frac = cap > 0 ? (input.spentMicros ?? 0) / cap : 0
  const ceiling: Tier | null = frac >= LADDER_LIMITS.hardAtFraction ? 'T1' : frac >= LADDER_LIMITS.downgradeAtFraction ? 'T2' : null
  if (ceiling && rank(tier) > rank(ceiling)) {
    const asked = tier
    tier = ceiling
    effort = TIER_TABLE[tier].effort
    reason = `budget: ${Math.round(frac * 100)}% of cap spent, ${asked} capped at ${tier}`
  }
  return { model: TIER_TABLE[tier].model, effort, tier, reason }
}
