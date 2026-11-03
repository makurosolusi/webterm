/** @vitest-environment jsdom */
// Daftar "Terbaru": dedupe per host, batas N, query/hash dibuang, non-http ditolak, storage rusak tidak crash.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECENT_MAX, RECENT_STORAGE_KEY, addRecent, loadRecent } from './browser.recent'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('browser.recent', () => {
  it('stores origin+path only, dropping query, hash and userinfo-free tokens', () => {
    addRecent('https://a.com/doc?token=SECRET#frag', 'Doc')
    expect(loadRecent()).toEqual([{ url: 'https://a.com/doc', host: 'a.com', title: 'Doc' }])
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).not.toContain('SECRET')
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'about:blank', 'https://u:p@a.com/', 'bukan url'])('rejects %s', (u) => {
    expect(addRecent(u, 't')).toEqual([])
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull()
  })

  it('dedupes per host, newest first', () => {
    addRecent('https://a.com/1', 'one')
    addRecent('https://b.com/', 'b')
    const list = addRecent('https://a.com/2', 'two')
    expect(list.map((i) => i.url)).toEqual(['https://a.com/2', 'https://b.com/'])
  })

  it('caps the list at RECENT_MAX, evicting the oldest', () => {
    for (let i = 0; i < RECENT_MAX + 3; i++) addRecent(`https://h${i}.com/`, `t${i}`)
    const list = loadRecent()
    expect(list).toHaveLength(RECENT_MAX)
    expect(list[0]?.host).toBe(`h${RECENT_MAX + 2}.com`)
    expect(list.some((i) => i.host === 'h0.com')).toBe(false)
  })

  it('re-sanitizes tampered stored data and ignores malformed json', () => {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([{ url: 'https://a.com/x?t=1', host: 'a.com', title: 'x' }, { url: 'javascript:1', host: 'x', title: 'y' }, 42]))
    expect(loadRecent()).toEqual([{ url: 'https://a.com/x', host: 'a.com', title: 'x' }])
    localStorage.setItem(RECENT_STORAGE_KEY, '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(loadRecent()).toEqual([])
  })

  it('does not crash when localStorage throws, and still returns the new list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(loadRecent()).toEqual([])
    expect(addRecent('https://a.com/', 'a')).toEqual([{ url: 'https://a.com/', host: 'a.com', title: 'a' }])
    expect(warn).toHaveBeenCalled()
  })
})
