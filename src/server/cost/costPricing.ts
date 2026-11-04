// Claude per-token prices and the cost math for one API response. One table, one source:
// https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-11-04). Update the table
// and PRICING_CHECKED_AT together when Anthropic changes a price; unknown models stay unpriced.

/** USD per million tokens. `cacheRead` already carries the per-model multiplier (0.1x / 0.05x / 0.025x). */
export interface ModelPrice { input: number; output: number; write5m: number; write1h: number; cacheRead: number }

export const PRICING_SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
export const PRICING_CHECKED_AT = '2026-11-04'

const p = (input: number, write5m: number, write1h: number, cacheRead: number, output: number): ModelPrice => ({ input, output, write5m, write1h, cacheRead })

/** Longest prefix wins, so `claude-opus-4-1` beats `claude-opus-4`. Model ids may carry a date suffix or `[1m]`. */
export const CLAUDE_PRICING: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ['claude-fable-5-1', p(10, 12.5, 20, 0.25, 50)],
  ['claude-mythos-5-1', p(10, 12.5, 20, 0.25, 50)],
  ['claude-fable-5', p(10, 12.5, 20, 1, 50)],
  ['claude-mythos-5', p(10, 12.5, 20, 1, 50)],
  ['claude-opus-5-5', p(4, 5, 8, 0.2, 20)],
  ['claude-opus-5', p(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-8', p(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-7', p(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-6', p(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-5', p(5, 6.25, 10, 0.5, 25)],
  ['claude-opus-4-1', p(15, 18.75, 30, 1.5, 75)],
  ['claude-opus-4', p(15, 18.75, 30, 1.5, 75)],
  ['claude-sonnet-5-5', p(2, 2.5, 4, 0.1, 10)],
  ['claude-sonnet-5', p(2, 2.5, 4, 0.2, 10)],
  ['claude-sonnet-4-6', p(3, 3.75, 6, 0.3, 15)],
  ['claude-sonnet-4-5', p(3, 3.75, 6, 0.3, 15)],
  ['claude-sonnet-4', p(3, 3.75, 6, 0.3, 15)],
  ['claude-haiku-5-5', p(0.1, 0.125, 0.2, 0.01, 0.5)],
  ['claude-haiku-4-5', p(1, 1.25, 2, 0.1, 5)],
  ['claude-3-5-haiku', p(0.8, 1, 1.6, 0.08, 4)],
]

/** Haiku 5.5 prompts over 100K input tokens (input + cache read + cache write) bill at this tier. */
const HAIKU_55_LONG = p(0.5, 0.625, 1, 0.05, 2.5)
const HAIKU_55_LONG_FROM = 100_000
/** Fast mode is 2x standard on every model that offers it; US-only inference (`inference_geo: us`) is 1.1x. */
const FAST_MULTIPLIER = 2
const US_GEO_MULTIPLIER = 1.1

/** Token buckets of one response. Cache writes are split by TTL because 1h costs more than 5m. */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
  speed?: string | null
  geo?: string | null
}

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null
  let best: readonly [string, ModelPrice] | null = null
  for (const row of CLAUDE_PRICING) if (model.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row
  return best ? best[1] : null
}

/** Cost in micro-USD (1e-6 $), or null when the model is not in the table (unknown != free). */
export function costMicros(model: string | null | undefined, u: TokenUsage): number | null {
  let price = priceFor(model)
  if (!price) return null
  if (model!.startsWith('claude-haiku-5-5') && u.input + u.cacheRead + u.write5m + u.write1h > HAIKU_55_LONG_FROM) price = HAIKU_55_LONG
  // $/MTok * tokens = micro-USD, so no further scaling.
  const base = u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead + u.write5m * price.write5m + u.write1h * price.write1h
  const mult = (u.speed === 'fast' ? FAST_MULTIPLIER : 1) * (u.geo === 'us' ? US_GEO_MULTIPLIER : 1)
  return Math.round(base * mult)
}
