import { describe, expect, it } from 'vitest'
import { COOKIE_PREVIEW_TTL_MS } from '../../shared/browser.contract'
import type { BrowserCookie } from './cookieImport.parse'
import { createCookiePreviewStore } from './cookieImport.preview'

const CANARY = 'cv-canary-7f3a' // test-only
const ck = (domain: string, expires = 1900000000): BrowserCookie =>
  ({ name: 'n', value: CANARY, domain, path: '/', expires, httpOnly: false, secure: true })

describe('cookie preview store', () => {
  it('summarizes domains and count without any cookie value', () => {
    const s = createCookiePreviewStore({ now: () => 1000 })
    const r = s.put('ws1', [ck('.b.com'), ck('b.com', -1), ck('a.org')])
    expect(r.domains).toEqual([{ domain: 'a.org', count: 1, hasSession: false }, { domain: 'b.com', count: 2, hasSession: true }])
    expect(r.expiresAt).toBe(1000 + COOKIE_PREVIEW_TTL_MS)
    expect(JSON.stringify(r)).not.toContain(CANARY)
  })

  it('take returns only the chosen domains and is one-shot', () => {
    const s = createCookiePreviewStore()
    const { previewId } = s.put('ws1', [ck('.b.com'), ck('a.org'), ck('c.net')])
    const got = s.take(previewId, 'ws1', ['b.com', 'zzz.io'])
    expect(got?.map((c) => c.domain)).toEqual(['.b.com'])
    expect(s.take(previewId, 'ws1', ['b.com'])).toBeNull()
  })

  it('expires by injected clock and is bound to the workspace', () => {
    let t = 0
    const s = createCookiePreviewStore({ now: () => t, ttlMs: 100 })
    const a = s.put('ws1', [ck('a.org')]).previewId
    expect(s.take(a, 'ws2', ['a.org'])).toBeNull() // beda workspace
    const b = s.put('ws1', [ck('a.org')]).previewId
    t = 100
    expect(s.take(b, 'ws1', ['a.org'])).toBeNull()
    expect(s.take('unknown', 'ws1', ['a.org'])).toBeNull()
  })

  it('evicts the oldest preview past the memory cap', () => {
    const s = createCookiePreviewStore()
    const first = s.put('ws1', [ck('a.org')]).previewId
    for (let i = 0; i < 16; i++) s.put('ws1', [ck('a.org')])
    expect(s.take(first, 'ws1', ['a.org'])).toBeNull()
  })

  it('names refused Google domains with counts only, and omits the field when nothing is refused', () => {
    const s = createCookiePreviewStore()
    const r = s.put('ws1', [ck('.google.com'), ck('accounts.google.com'), ck('.google.com'), ck('a.org')])
    expect(r.blocked).toEqual([
      { domain: 'accounts.google.com', count: 1, reason: 'google_source_bound' },
      { domain: 'google.com', count: 2, reason: 'google_source_bound' },
    ])
    expect(r.domains.map((d) => d.domain)).toEqual(['a.org'])
    expect(r.googleSkipped).toBe(3)
    expect(JSON.stringify(r)).not.toContain(CANARY)
    expect('blocked' in s.put('ws1', [ck('a.org')])).toBe(false)
  })
})
