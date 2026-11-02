import { describe, expect, it } from 'vitest'
import { escapeFilterTerm, matchesFilter, parseFilter } from './outputFilter'

describe('parseFilter', () => {
  it('splits comma terms, trims, lowercases and drops empties', () => {
    expect(parseFilter(' Foo , bar ,, ')).toEqual({ include: ['foo', 'bar'], exclude: [] })
  })
  it('treats a leading ! as exclude', () => {
    expect(parseFilter('pty, !noise , ! spaced')).toEqual({ include: ['pty'], exclude: ['noise', 'spaced'] })
  })
  it('honours backslash escapes for comma, bang and backslash', () => {
    expect(parseFilter('a\\,b, \\!c, d\\\\e')).toEqual({ include: ['a,b', '!c', 'd\\e'], exclude: [] })
  })
  it('returns empty sets for blank input', () => {
    expect(parseFilter('  ')).toEqual({ include: [], exclude: [] })
  })
})

describe('matchesFilter', () => {
  const line = '2026-11-02 [info] [pty] Spawned shell'
  it('matches everything with no terms', () => {
    expect(matchesFilter(parseFilter(''), line)).toBe(true)
  })
  it('include terms are OR and case-insensitive', () => {
    expect(matchesFilter(parseFilter('nope, SPAWNED'), line)).toBe(true)
    expect(matchesFilter(parseFilter('nope, other'), line)).toBe(false)
  })
  it('exclude wins over include', () => {
    expect(matchesFilter(parseFilter('pty, !shell'), line)).toBe(false)
    expect(matchesFilter(parseFilter('!auth'), line)).toBe(true)
  })
  it('escapeFilterTerm round-trips through parseFilter', () => {
    const raw = '!weird,id\\x'
    expect(parseFilter(escapeFilterTerm(raw)).include).toEqual([raw.toLowerCase()])
  })
})
