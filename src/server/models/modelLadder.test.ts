// Model ladder: tier defaults per call kind, escalation per failure type, step/tier ceilings, override, budget.
import { describe, expect, it } from 'vitest'
import { FABLE_NEEDS_APPROVAL, defaultTier, effortLadder, LADDER_LIMITS, MODEL_IDS, nextStep, resolveModel, TIER_TABLE, type CallKind, type Effort, type Tier } from './modelLadder'

describe('TIER_TABLE / MODEL_IDS / effortLadder', () => {
  it('maps every tier to its model and default effort', () => {
    expect(TIER_TABLE).toEqual({
      T0: { model: null, effort: null }, T1: { model: 'haiku', effort: 'low' }, T2: { model: 'sonnet', effort: 'medium' },
      T3: { model: 'opus', effort: 'high' }, T4: { model: 'fable', effort: 'xhigh' },
    })
    expect(LADDER_LIMITS).toEqual({ maxSteps: 2, maxAutoTier: 'T3', downgradeAtFraction: 0.8, hardAtFraction: 1 })
  })
  it('maps aliases to full ids', () => {
    expect(MODEL_IDS).toEqual({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' })
  })
  it.each<[Effort, Effort | null]>([['low', 'medium'], ['medium', 'high'], ['high', 'xhigh'], ['xhigh', null], ['max', null]])('effortLadder(%s) = %s', (e, up) => {
    expect(effortLadder(e)).toBe(up)
  })
})

describe('defaultTier', () => {
  it.each<[CallKind, 'simple' | 'moderate' | 'complex' | undefined, Tier]>([
    ['helper', undefined, 'T1'], ['explore', undefined, 'T1'], ['central', undefined, 'T2'], ['dag-planner', undefined, 'T3'],
    ['dag-worker', 'simple', 'T2'], ['dag-worker', 'moderate', 'T2'], ['dag-worker', 'complex', 'T3'], ['dag-worker', undefined, 'T2'],
    ['routine', undefined, 'T2'], ['prreview', undefined, 'T2'], ['bakeoff', undefined, 'T2'], ['agent-spawn', undefined, 'T2'], ['agent-spawn', 'simple', 'T1'], ['agent-spawn', 'moderate', 'T2'], ['agent-spawn', 'complex', 'T3'],
    ['helper', 'complex', 'T1'],
  ])('%s/%s -> %s', (kind, complexity, tier) => {
    expect(defaultTier(kind, complexity)).toBe(tier)
  })
})

describe('nextStep', () => {
  it.each(['verify_failed', 'no_changes'] as const)('%s climbs one tier and resets effort', (f) => {
    expect(nextStep('T1', 'low', f, 0)).toEqual({ tier: 'T2', effort: 'medium' })
    expect(nextStep('T2', 'xhigh', f, 1)).toEqual({ tier: 'T3', effort: 'high' })
    expect(nextStep('T0', 'low', f, 0)).toEqual({ tier: 'T1', effort: 'low' })
  })
  it('timeout raises effort first, then the tier', () => {
    expect(nextStep('T1', 'low', 'timeout', 0)).toEqual({ tier: 'T1', effort: 'medium' })
    expect(nextStep('T2', 'high', 'timeout', 0)).toEqual({ tier: 'T2', effort: 'xhigh' })
    expect(nextStep('T2', 'xhigh', 'timeout', 0)).toEqual({ tier: 'T3', effort: 'high' })
    expect(nextStep('T0', 'low', 'timeout', 0)).toEqual({ tier: 'T1', effort: 'low' })
  })
  it.each(['lease_violation', 'policy_denied', null, undefined] as const)('%s never escalates', (f) => {
    expect(nextStep('T1', 'low', f, 0)).toBeNull()
  })
  it('stops after maxSteps escalations', () => {
    expect(nextStep('T1', 'low', 'verify_failed', 2)).toBeNull()
    expect(nextStep('T1', 'low', 'timeout', 5)).toBeNull()
  })
  it('never climbs above T3 on its own', () => {
    expect(nextStep('T3', 'high', 'verify_failed', 0)).toBeNull()
    expect(nextStep('T3', 'xhigh', 'timeout', 0)).toBeNull()
    expect(nextStep('T3', 'high', 'timeout', 0)).toEqual({ tier: 'T3', effort: 'xhigh' })
    expect(nextStep('T4', 'xhigh', 'verify_failed', 0)).toBeNull()
  })
})

describe('resolveModel', () => {
  it('first attempt is the kind default', () => {
    expect(resolveModel({ kind: 'central' })).toEqual({ model: 'sonnet', effort: 'medium', tier: 'T2', reason: 'default for central' })
    expect(resolveModel({ kind: 'dag-worker', complexity: 'complex' })).toMatchObject({ model: 'opus', effort: 'high', tier: 'T3' })
    expect(resolveModel({ kind: 'helper', tier: 'T0' })).toMatchObject({ model: null, effort: null, tier: 'T0' })
  })
  it('replays escalation per attempt and caps at maxSteps', () => {
    expect(resolveModel({ kind: 'helper', attempt: 1, lastFailure: 'verify_failed' })).toMatchObject({ tier: 'T2', model: 'sonnet', effort: 'medium' })
    expect(resolveModel({ kind: 'helper', attempt: 2, lastFailure: 'verify_failed' })).toMatchObject({ tier: 'T3', model: 'opus', reason: 'escalated 2 step(s) after verify_failed' })
    expect(resolveModel({ kind: 'helper', attempt: 5, lastFailure: 'no_changes' })).toMatchObject({ tier: 'T3' })
    expect(resolveModel({ kind: 'helper', attempt: 2, lastFailure: 'timeout' })).toMatchObject({ tier: 'T1', effort: 'high' })
  })
  it('never auto-escalates above T3 and never on lease/policy failures', () => {
    expect(resolveModel({ kind: 'dag-planner', attempt: 2, lastFailure: 'verify_failed' })).toMatchObject({ tier: 'T3', effort: 'high', reason: 'default for dag-planner' })
    expect(resolveModel({ kind: 'central', attempt: 2, lastFailure: 'lease_violation' })).toMatchObject({ tier: 'T2' })
    expect(resolveModel({ kind: 'central', attempt: 2, lastFailure: 'policy_denied' })).toMatchObject({ tier: 'T2' })
  })
  it('an override wins, skips escalation and budget', () => {
    const base = { kind: 'helper' as const, attempt: 2, lastFailure: 'verify_failed' as const, spentMicros: 200, capMicros: 100 }
    expect(resolveModel({ ...base, override: { model: 'fable' }, fableGranted: true })).toEqual({ model: 'fable', effort: 'xhigh', tier: 'T4', reason: 'user override', fableGranted: true })
    expect(resolveModel({ ...base, override: { model: 'claude-opus-5-5', effort: 'max' } })).toEqual({ model: 'opus', effort: 'max', tier: 'T3', reason: 'user override' })
    expect(resolveModel({ ...base, override: { effort: 'high' } })).toEqual({ model: 'haiku', effort: 'high', tier: 'T1', reason: 'user override' })
    expect(resolveModel({ ...base, override: {} })).toMatchObject({ tier: 'T1', reason: expect.stringContaining('budget') })
  })
  it('Fable without a grant resolves to Opus, on every path that names it', () => {
    const blocked = { model: 'opus', tier: 'T3', reason: FABLE_NEEDS_APPROVAL, fableBlocked: true }
    expect(resolveModel({ kind: 'central', override: { model: 'fable' } })).toMatchObject({ ...blocked, effort: 'high' })
    expect(resolveModel({ kind: 'central', override: { model: 'claude-fable-5-1', effort: 'max' } })).toMatchObject({ ...blocked, effort: 'max' })
    expect(resolveModel({ kind: 'dag-worker', tier: 'T4' })).toMatchObject(blocked)
    expect(resolveModel({ kind: 'central', override: { model: 'fable' }, fableGranted: false })).toMatchObject(blocked)
  })
  it('the ladder never reaches Fable on its own, grant or not', () => {
    expect(resolveModel({ kind: 'central', attempt: 5, lastFailure: 'verify_failed', fableGranted: true }).model).not.toBe('fable')
  })
  it('budget >= 80% caps at T2, >= 100% caps at T1, helpers stay T1', () => {
    expect(resolveModel({ kind: 'dag-planner', spentMicros: 79, capMicros: 100 })).toMatchObject({ tier: 'T3' })
    expect(resolveModel({ kind: 'dag-planner', spentMicros: 80, capMicros: 100 })).toMatchObject({ tier: 'T2', model: 'sonnet', effort: 'medium', reason: expect.stringMatching(/^budget/) })
    expect(resolveModel({ kind: 'central', spentMicros: 90, capMicros: 100 })).toMatchObject({ tier: 'T2', reason: 'default for central' })
    expect(resolveModel({ kind: 'dag-planner', spentMicros: 100, capMicros: 100 })).toMatchObject({ tier: 'T1', model: 'haiku', effort: 'low', reason: expect.stringMatching(/^budget/) })
    expect(resolveModel({ kind: 'central', spentMicros: 150, capMicros: 100 })).toMatchObject({ tier: 'T1', reason: expect.stringMatching(/^budget/) })
    expect(resolveModel({ kind: 'helper', spentMicros: 150, capMicros: 100 })).toMatchObject({ tier: 'T1', reason: 'default for helper' })
    expect(resolveModel({ kind: 'helper', attempt: 2, lastFailure: 'verify_failed', spentMicros: 85, capMicros: 100 })).toMatchObject({ tier: 'T2' })
    expect(resolveModel({ kind: 'dag-planner', spentMicros: 500, capMicros: 0 })).toMatchObject({ tier: 'T3' })
  })
})
