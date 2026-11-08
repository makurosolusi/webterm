import { describe, expect, it } from 'vitest'
import { DEFAULT_TURN_STEPS, DEFAULT_TURN_WALL_MS, resolveLimits, TURN_STEPS_FLAG, TURN_WALL_MS_FLAG } from './turnLimits'

describe('resolveLimits', () => {
  it('defaults to 12 steps and 120 s', () => {
    expect(resolveLimits({})).toEqual({ maxTurns: 12, maxWallMs: 120_000 })
    expect([DEFAULT_TURN_STEPS, DEFAULT_TURN_WALL_MS]).toEqual([12, 120_000])
  })

  it('reads overrides from env', () => {
    const env = { [TURN_STEPS_FLAG]: '3', [TURN_WALL_MS_FLAG]: ' 5000 ' }
    expect(resolveLimits(env)).toEqual({ maxTurns: 3, maxWallMs: 5000 })
  })

  it('ignores zero, negative, fractional and non-numeric values', () => {
    for (const bad of ['0', '-4', '1.5', 'abc', '', '  ']) {
      const env = { [TURN_STEPS_FLAG]: bad, [TURN_WALL_MS_FLAG]: bad }
      expect(resolveLimits(env)).toEqual({ maxTurns: 12, maxWallMs: 120_000 })
    }
  })

  it('no longer reads the removed turn token key', () => {
    expect(resolveLimits({ WEBTERM_CENTRAL_TURN_TOKENS: '1000' })).toEqual({ maxTurns: 12, maxWallMs: 120_000 })
  })
})
