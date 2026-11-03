import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_ENV, DEFAULT_CONTEXT_WINDOW_TOKENS, contextWindowTokens, decideRotation } from './rotationPolicy'

describe('decideRotation', () => {
  it.each([
    [null, 'ok'], [0, 'ok'], [69_999, 'ok'], [70_000, 'rotate'], [84_999, 'rotate'], [85_000, 'reject'], [200_000, 'reject'],
  ] as const)('ctx %s of 100000 -> %s', (ctx, expected) => {
    expect(decideRotation(ctx, 100_000)).toBe(expected)
  })
  it('treats a non-positive window as unknown', () => {
    expect(decideRotation(5_000, 0)).toBe('ok')
  })
})

describe('contextWindowTokens', () => {
  it('reads the env override and falls back on junk', () => {
    expect(contextWindowTokens({ [CONTEXT_WINDOW_ENV]: '32000' })).toBe(32_000)
    expect(contextWindowTokens({ [CONTEXT_WINDOW_ENV]: 'abc' })).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(contextWindowTokens({ [CONTEXT_WINDOW_ENV]: '-5' })).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(contextWindowTokens({})).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
  })
})
