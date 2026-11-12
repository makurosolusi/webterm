import { describe, expect, it } from 'vitest'
import { nearDuplicatePair, NEAR_DUPLICATE_MIN_SIMILARITY, textSimilarity } from './AgentMemoryMerge'
import type { MemoryItem } from './AgentMemory.api'

// test-only
const m = (id: string, text: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id, kind: 'procedural', scope: 'global', status: 'fact', trust: 'human', origin: null, title: '', text, suppressed: false, freshness: 1, needsReview: false, validFrom: 0, updatedAt: 0, ...over,
})

describe('near-duplicate detection', () => {
  it('one swapped word in a sentence is alike; different rules are not', () => {
    expect(textSimilarity('User communicates in Indonesian; reply in Indonesian.', 'user communicates in indonesian — respond in Indonesian')).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_SIMILARITY)
    expect(textSimilarity('Use tabs', 'Use spaces')).toBeLessThan(NEAR_DUPLICATE_MIN_SIMILARITY)
    expect(textSimilarity('', 'x')).toBe(0)
  })

  it('keeps the newer one, on a tie the longer one; skips muted and web-page memories', () => {
    const [keep, drop] = nearDuplicatePair([m('a', 'Always run the tests first', { updatedAt: 5 }), m('b', 'Always run the tests first!', { updatedAt: 1 })])!
    expect([keep.id, drop.id]).toEqual(['a', 'b'])
    expect(nearDuplicatePair([m('a', 'Run tests'), m('b', 'Run tests please')])!.map((x) => x.id)).toEqual(['b', 'a'])
    expect(nearDuplicatePair([m('a', 'Run tests'), m('b', 'Run tests', { suppressed: true })])).toBeNull()
    expect(nearDuplicatePair([m('a', 'Run tests'), m('b', 'Run tests', { trust: 'external' })])).toBeNull()
    expect(nearDuplicatePair([m('a', 'Run tests'), m('b', 'Run tests')], new Set(['a|b']))).toBeNull()
  })
})
