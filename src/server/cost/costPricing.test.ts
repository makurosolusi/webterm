// Pricing math: every bucket incl. both cache-write TTLs, longest-prefix match, tiers, multipliers.
import { describe, expect, it } from 'vitest'
import { costMicros, priceFor } from './costPricing'
import { parseTranscriptUsage, parseUsageLine } from './costTranscript'

const zero = { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 }

describe('costMicros', () => {
  it('prices Opus 5.5 per bucket: $4 in, $20 out, $5 5m write, $8 1h write, $0.20 cache read', () => {
    expect(costMicros('claude-opus-5-5', { ...zero, input: 1_000_000 })).toBe(4_000_000)
    expect(costMicros('claude-opus-5-5', { ...zero, output: 1_000_000 })).toBe(20_000_000)
    expect(costMicros('claude-opus-5-5', { ...zero, write5m: 1_000_000 })).toBe(5_000_000)
    expect(costMicros('claude-opus-5-5', { ...zero, write1h: 1_000_000 })).toBe(8_000_000)
    expect(costMicros('claude-opus-5-5', { ...zero, cacheRead: 1_000_000 })).toBe(200_000)
  })

  it('sums a real transcript response (2 in, 373 out, 22231 read, 29902 1h write)', () => {
    // 2*4 + 373*20 + 22231*0.2 + 29902*8 = 8 + 7460 + 4446.2 + 239216 = 251130.2
    expect(costMicros('claude-opus-5-5', { input: 2, output: 373, cacheRead: 22_231, write5m: 0, write1h: 29_902 })).toBe(251_130)
  })

  it('matches the longest prefix and tolerates suffixes', () => {
    expect(priceFor('claude-opus-4-1-20250805')?.input).toBe(15)
    expect(priceFor('claude-opus-4-5')?.input).toBe(5)
    expect(priceFor('claude-sonnet-5-5[1m]')?.cacheRead).toBe(0.1)
    expect(priceFor('claude-sonnet-5')?.cacheRead).toBe(0.2)
  })

  it('switches Haiku 5.5 to the long-prompt tier above 100K input-side tokens', () => {
    expect(costMicros('claude-haiku-5-5', { ...zero, input: 100_000 })).toBe(10_000)
    expect(costMicros('claude-haiku-5-5', { ...zero, input: 60_000, cacheRead: 50_000 })).toBe(60_000 * 0.5 + 50_000 * 0.05)
  })

  it('applies fast mode (2x) and US-only inference (1.1x)', () => {
    expect(costMicros('claude-opus-5-5', { ...zero, output: 1_000, speed: 'fast' })).toBe(40_000)
    expect(costMicros('claude-opus-5-5', { ...zero, output: 1_000, geo: 'us' })).toBe(22_000)
  })

  it('returns null for an unknown model instead of zero', () => {
    expect(costMicros('gpt-5', { ...zero, input: 10 })).toBeNull()
    expect(costMicros(null, zero)).toBeNull()
  })
})

// test-only fixture: shapes copied from a Claude Code 2.x transcript, content removed
const line = (id: string, usage: Record<string, unknown>, model = 'claude-opus-5-5', type = 'assistant'): string =>
  JSON.stringify({ type, sessionId: 's1', timestamp: '2026-11-03T17:18:41.264Z', message: { id, model, usage, content: [] } })
const USAGE = { input_tokens: 2, output_tokens: 373, cache_read_input_tokens: 22231, cache_creation_input_tokens: 29902, cache_creation: { ephemeral_1h_input_tokens: 29902, ephemeral_5m_input_tokens: 0 }, speed: 'standard', inference_geo: 'global' }

describe('parseTranscriptUsage', () => {
  it('keys responses by message id: repeated lines of one response count once, the last line wins', () => {
    const text = [line('msg_a', { ...USAGE, output_tokens: 10 }), line('msg_a', USAGE), line('msg_b', { input_tokens: 5, output_tokens: 1 })].join('\n')
    const out = parseTranscriptUsage(text)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ messageId: 'msg_a', model: 'claude-opus-5-5', sessionId: 's1', input: 2, output: 373, cacheRead: 22231, write1h: 29902, write5m: 0, ts: Date.parse('2026-11-03T17:18:41.264Z'), geo: 'global' })
  })

  it('treats a write without a TTL split as 5m and skips synthetic, user and broken lines', () => {
    expect(parseUsageLine(line('msg_c', { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 70 }))).toMatchObject({ write5m: 70, write1h: 0 })
    expect(parseUsageLine(line('msg_d', USAGE, '<synthetic>'))).toBeNull()
    expect(parseUsageLine(line('msg_e', USAGE, 'claude-opus-5-5', 'user'))).toBeNull()
    expect(parseUsageLine('{"type":"assistant","message":{"usage":')).toBeNull()
  })
})
