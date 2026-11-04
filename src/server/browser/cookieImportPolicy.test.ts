// Kebijakan Orca "Google logins aren't imported": unit (kasus diadaptasi dari Orca
// browser-cookie-import-policy.test.ts) + jalur penuh preview -> commit lewat rute cookie.
import { describe, expect, it } from 'vitest'
import { handleBrowserApi } from '../browserApi'
import type { BrowserApiDeps } from '../browserApi'
import { logBus } from '../logs'
import type { BrowserCookie } from './cookieImport.parse'
import { createCookiePreviewStore } from './cookieImport.preview'
import { isGoogleSourceBoundCookie, isNonTransplantableCookieDomain, normalizeCookieDomain, partitionImportableCookies } from './cookieImportPolicy'

const CANARY = 'gpol-canary-51c2' // test-only: nilai cookie sintetis

describe('cookie import policy (Orca port)', () => {
  it('isGoogleSourceBoundCookie matches allowlisted names only on google.com and subdomains', () => {
    expect(isGoogleSourceBoundCookie('SIDCC', '.google.com')).toBe(true)
    expect(isGoogleSourceBoundCookie('AEC', 'accounts.google.com')).toBe(true)
    expect(isGoogleSourceBoundCookie('__Secure-STRP', '.accounts.google.com')).toBe(true)
    expect(isGoogleSourceBoundCookie('SIDCC', '.notgoogle.com')).toBe(false)
    expect(isGoogleSourceBoundCookie('SIDCC', '.google.com.evil.example')).toBe(false)
    expect(isGoogleSourceBoundCookie('SID', '.google.com')).toBe(false)
    expect(isGoogleSourceBoundCookie('SIDCC', 'user@google.com')).toBe(false)
  })

  it('normalizeCookieDomain canonicalizes and rejects URL syntax', () => {
    expect(normalizeCookieDomain('..Accounts.Google.Com')).toBe('accounts.google.com')
    expect(normalizeCookieDomain('münich.example')).toBe('xn--mnich-kva.example')
    for (const bad of ['', 'example.com/path', 'user@example.com', 'example.com:443', '%65xample.com']) expect(normalizeCookieDomain(bad)).toBeNull()
  })

  it('isNonTransplantableCookieDomain covers the google.com family but not lookalikes or YouTube', () => {
    for (const d of ['google.com', '.google.com', 'accounts.google.com', 'MAIL.Google.Com']) expect(isNonTransplantableCookieDomain(d)).toBe(true)
    for (const d of ['withgoogle.com', 'google.com.evil.example', '.youtube.com', 'example.org']) expect(isNonTransplantableCookieDomain(d)).toBe(false)
  })

  it('partition keeps non-Google cookies untouched and counts the skipped', () => {
    const c = (name: string, domain: string) => ({ name, domain, value: CANARY })
    const input = [c('SID', '.google.com'), c('LSID', 'accounts.google.com'), c('a', '.github.com'), c('b', '.youtube.com')]
    const r = partitionImportableCookies(input)
    expect(r.googleSkipped).toBe(2)
    expect(r.importable).toEqual([input[2], input[3]]) // objek identik, tak diubah
  })
})

// cookies.txt (Netscape) — test-only fixture: dua domain auth Google + domain lain.
const FIXTURE = [
  '# Netscape HTTP Cookie File',
  `.google.com\tTRUE\t/\tTRUE\t1900000000\tSID\t${CANARY}`,
  `.google.com\tTRUE\t/\tTRUE\t1900000000\tSIDCC\t${CANARY}`,
  `#HttpOnly_accounts.google.com\tFALSE\t/\tTRUE\t1900000000\t__Host-GAPS\t${CANARY}`,
  `.github.com\tTRUE\t/\tTRUE\t1900000000\tuser_session\t${CANARY}`,
  `.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO1_LIVE\t${CANARY}`,
  `example.org\tFALSE\t/\tFALSE\t1900000000\tpref\t${CANARY}`,
].join('\n')

describe('file import skips Google auth cookies end to end', () => {
  it('preview reports skipped count, commit imports only the other domains, logs carry no value', async () => {
    const injected: BrowserCookie[] = []
    const saved: BrowserCookie[] = []
    const d = {
      status: () => ({ enabled: true, binFound: true, live: 0, maxLive: 1, agentEnabled: false, cookieImportEnabled: true }),
      preview: createCookiePreviewStore(),
      vault: { save: (_w: string, c: BrowserCookie[]) => void saved.push(...c) },
      injector: { inject: async (_w: string, c: BrowserCookie[]) => void injected.push(...c), remove: async () => {} },
    } as unknown as BrowserApiDeps // test-only: hanya dependensi rute cookie yang dipakai
    const body = (v: unknown) => () => Promise.resolve(JSON.stringify(v))

    const p = await handleBrowserApi('POST', '/api/browser/ws1/cookies/preview', body({ format: 'netscape', content: FIXTURE }), d)
    expect(p?.status).toBe(200)
    const pv = p?.body as { previewId: string; googleSkipped: number; domains: Array<{ domain: string; count: number }> }
    expect(pv.googleSkipped).toBe(3)
    expect(pv.domains.map((x) => x.domain)).toEqual(['example.org', 'github.com', 'youtube.com'])
    expect(JSON.stringify(p)).not.toContain(CANARY)

    // Meminta domain Google secara eksplisit tetap tak menghasilkan cookie Google.
    const c = await handleBrowserApi('POST', '/api/browser/ws1/cookies/commit',
      body({ previewId: pv.previewId, domains: ['google.com', 'accounts.google.com', 'github.com', 'youtube.com', 'example.org'] }), d)
    expect(c?.status).toBe(200)
    expect(c?.body).toEqual({ imported: 3, domains: ['example.org', 'github.com', 'youtube.com'] })
    for (const set of [injected, saved]) {
      expect(set.map((x) => x.name).sort()).toEqual(['VISITOR_INFO1_LIVE', 'pref', 'user_session'])
      expect(set.every((x) => !isNonTransplantableCookieDomain(x.domain))).toBe(true)
    }
    expect(JSON.stringify(logBus.query({ channel: 'browser.cookies' }))).not.toContain(CANARY)
  })

  it('a file of only Google cookies previews zero domains and cannot be committed', async () => {
    const s = createCookiePreviewStore()
    const r = s.put('ws1', [{ name: 'SID', value: CANARY, domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true }])
    expect(r).toMatchObject({ domains: [], googleSkipped: 1 })
    expect(s.take(r.previewId, 'ws1', ['google.com'])).toEqual([])
  })
})
