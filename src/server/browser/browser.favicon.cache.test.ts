import { describe, expect, it } from 'vitest'
import { createFaviconCache, FAVICON_CACHE_MAX_BYTES, FAVICON_CACHE_MAX_ENTRIES, FAVICON_CACHE_TTL_MS } from './browser.favicon.cache'

describe('favicon cache', () => {
  it('is keyed by profile and url', () => {
    const c = createFaviconCache()
    c.set('p1', 'https://a.test/i', 'data:1')
    expect(c.get('p1', 'https://a.test/i')).toBe('data:1')
    expect(c.get('p2', 'https://a.test/i')).toBeUndefined()
    expect(c.get('p1', 'https://a.test/other')).toBeUndefined()
  })

  it('remembers "no usable icon" as null, distinct from a miss', () => {
    const c = createFaviconCache()
    c.set('p', 'u', null)
    expect(c.get('p', 'u')).toBeNull()
  })

  it('expires entries after the TTL', () => {
    let t = 0
    const c = createFaviconCache(() => t)
    c.set('p', 'u', 'd')
    t = FAVICON_CACHE_TTL_MS
    expect(c.get('p', 'u')).toBe('d')
    t = FAVICON_CACHE_TTL_MS + 1
    expect(c.get('p', 'u')).toBeUndefined()
  })

  it('evicts the least recently used entry past the entry limit', () => {
    const c = createFaviconCache()
    for (let i = 0; i < FAVICON_CACHE_MAX_ENTRIES; i++) c.set('p', `u${i}`, 'x')
    c.get('p', 'u0') // touched: u1 is now the oldest
    c.set('p', 'new', 'x')
    expect(c.size()).toBe(FAVICON_CACHE_MAX_ENTRIES)
    expect(c.get('p', 'u0')).toBe('x')
    expect(c.get('p', 'u1')).toBeUndefined()
  })

  it('evicts by total size too', () => {
    const c = createFaviconCache()
    const chunk = 'x'.repeat(FAVICON_CACHE_MAX_BYTES / 4 + 1)
    for (let i = 0; i < 5; i++) c.set('p', `u${i}`, chunk)
    expect(c.size()).toBeLessThanOrEqual(3)
    expect(c.get('p', 'u4')).toBe(chunk)
    expect(c.get('p', 'u0')).toBeUndefined()
  })

  it('replacing an entry does not double count its size', () => {
    const c = createFaviconCache()
    const chunk = 'x'.repeat(FAVICON_CACHE_MAX_BYTES / 2)
    for (let i = 0; i < 10; i++) c.set('p', 'same', chunk)
    expect(c.size()).toBe(1)
  })
})
