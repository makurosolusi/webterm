import { describe, expect, it } from 'vitest'
import {
  CapExceededError,
  DEFAULT_CAPS,
  assertCaps,
  checkCaps,
  emptyCapSnapshot,
  type CapLimits,
  type CapSnapshot,
} from './caps'

const snapshot = (patch: Partial<CapSnapshot> = {}): CapSnapshot => ({
  ...emptyCapSnapshot(),
  ...patch,
})

describe('defaults', () => {
  it('encodes 3 parallel workers, 3 attempts, 10 minute lease', () => {
    expect(DEFAULT_CAPS.maxParallelWorkers).toBe(3)
    expect(DEFAULT_CAPS.maxAttemptsPerTask).toBe(3)
    expect(DEFAULT_CAPS.leaseMs).toBe(600_000)
    expect(DEFAULT_CAPS.maxTokens).toBeGreaterThan(0)
    expect(DEFAULT_CAPS.maxCostMicros).toBeGreaterThan(0)
    expect(DEFAULT_CAPS.maxTurns).toBeGreaterThan(0)
    expect(DEFAULT_CAPS.maxWallMs).toBeGreaterThan(0)
  })

  it('allows a request that stays under every limit', () => {
    expect(checkCaps(snapshot(), { workers: 1, attempt: 1, leaseMs: DEFAULT_CAPS.leaseMs })).toEqual({
      ok: true,
    })
  })
})

describe('parallel workers', () => {
  it('allows the third worker and blocks the fourth', () => {
    expect(checkCaps(snapshot({ activeWorkers: 2 }), { workers: 1 }).ok).toBe(true)
    const denied = checkCaps(snapshot({ activeWorkers: 3 }), { workers: 1 })
    expect(denied).toEqual({
      ok: false,
      denials: [{ code: 'parallel_workers', actual: 4, limit: 3 }],
    })
  })

  it('counts workers already in flight against the request', () => {
    const denied = checkCaps(snapshot({ activeWorkers: 2 }), { workers: 2 })
    expect(denied.ok).toBe(false)
  })
})

describe('attempts', () => {
  it('blocks attempt 4 of a task', () => {
    expect(checkCaps(snapshot(), { attempt: 3 }).ok).toBe(true)
    expect(checkCaps(snapshot(), { attempt: 4 })).toEqual({
      ok: false,
      denials: [{ code: 'attempts', actual: 4, limit: 3 }],
    })
  })

  it('falls back to the snapshot attempt count when the request omits it', () => {
    expect(checkCaps(snapshot({ attemptsUsed: 4 })).ok).toBe(false)
  })
})

describe('budget, turns, wall clock, lease', () => {
  it('blocks on tokens, cost, turns, and wall time with typed reasons', () => {
    const limits: CapLimits = { ...DEFAULT_CAPS, maxTokens: 100, maxCostMicros: 100, maxTurns: 5, maxWallMs: 1_000 }
    const decision = checkCaps(
      snapshot({ tokensUsed: 90, costMicros: 90, turnsUsed: 4, elapsedMs: 900 }),
      { tokens: 20, costMicros: 20, turns: 2, elapsedMs: 200 },
      limits
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('unreachable')
    expect(decision.denials.map((d) => d.code)).toEqual([
      'tokens',
      'cost_usd',
      'turns',
      'wall_time',
    ])
    expect(decision.denials[0]).toEqual({ code: 'tokens', actual: 110, limit: 100 })
  })

  it('blocks a lease longer than the cap', () => {
    const denied = checkCaps(snapshot(), { leaseMs: DEFAULT_CAPS.leaseMs + 1 })
    expect(denied).toEqual({
      ok: false,
      denials: [{ code: 'lease_ttl', actual: 600_001, limit: 600_000 }],
    })
  })
})

describe('fail-closed behaviour', () => {
  it('turns a denial into a typed exception for mutating callers', () => {
    expect(() => assertCaps(snapshot({ activeWorkers: 3 }), { workers: 1 })).toThrow(
      CapExceededError
    )
    try {
      assertCaps(snapshot({ activeWorkers: 3 }), { workers: 1 })
    } catch (err) {
      expect((err as CapExceededError).denials).toEqual([
        { code: 'parallel_workers', actual: 4, limit: 3 },
      ])
    }
  })

  it('rejects negative or non-finite usage instead of silently clamping', () => {
    expect(() => checkCaps(snapshot({ tokensUsed: -1 }))).toThrow(RangeError)
    expect(() => checkCaps(snapshot(), { workers: Number.NaN })).toThrow(RangeError)
    expect(() => checkCaps(snapshot(), {}, { ...DEFAULT_CAPS, maxTokens: 0 })).toThrow(RangeError)
  })
})
