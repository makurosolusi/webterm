// Omnibox: tabel kasus diadaptasi dari Orca `src/shared/browser-url.test.ts`, plus guard webterm (hanya http/https).
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { buildSearchUrl, resolveOmniboxInput, SEARCH_ENGINES, toSearchEngine } from './browser.omnibox'

const go = (raw: string, engine?: Parameters<typeof resolveOmniboxInput>[1]) => {
  const p = resolveOmniboxInput(raw, engine)
  return p && p.ok ? p.url : p
}

describe('resolveOmniboxInput', () => {
  it.each([
    ['https://x.y/z', 'https://x.y/z'],
    ['  https://a.com/x?q=1  ', 'https://a.com/x?q=1'],
    ['http://example.com', 'http://example.com/'],
    ['github.com', 'https://github.com/'],
    ['sub.example.co.id/path?x=1', 'https://sub.example.co.id/path?x=1'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost:3000/app', 'http://localhost:3000/app'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['0.0.0.0:5173', 'http://0.0.0.0:5173/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['app.localhost:3000', 'http://app.localhost:3000/'],
    ['example.com:8443/x', 'https://example.com:8443/x'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['192.168.1.5:3000', 'http://192.168.1.5:3000/'],
    ['10.0.0.7:8080/app', 'http://10.0.0.7:8080/app'],
    ['172.20.1.2', 'http://172.20.1.2/'],
    ['169.254.1.1', 'http://169.254.1.1/'],
    ['intranet:8080', 'http://intranet:8080/'],
    ['intranet:8080/wiki?a=1', 'http://intranet:8080/wiki?a=1'],
    ['printer.local', 'http://printer.local/'],
    ['nas.local:5000', 'http://nas.local:5000/'],
    ['localhost', 'http://localhost/'],
    ['172.32.0.1', 'https://172.32.0.1/'],
    ['8.8.8.8', 'https://8.8.8.8/'],
  ])('navigates %s -> %s', (input, url) => expect(go(input)).toBe(url))

  it.each([
    ['github topic agent', 'github%20topic%20agent'],
    ['node.js tutorial', 'node.js%20tutorial'],
    ['example.com/a b', 'example.com%2Fa%20b'],
    ['kucing', 'kucing'],
    ['/etc/passwd', '%2Fetc%2Fpasswd'],
    ['a&b=c?#', 'a%26b%3Dc%3F%23'],
  ])('searches %s', (input, q) => expect(go(input)).toBe(SEARCH_ENGINES.google.prefix + q))

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['data:text/html,<b>x</b>', 'scheme'],
    ['about:blank', 'scheme'],
    ['https://u:p@a.com/', 'userinfo'],
  ])('rejects %s (%s) without navigating', (input, reason) => expect(go(input)).toEqual({ ok: false, reason }))

  it('LAN rules never let userinfo through', () => {
    expect(go('u:p@192.168.1.1')).toEqual({ ok: false, reason: 'userinfo' })
  })

  it('returns null for blank input', () => {
    expect(resolveOmniboxInput('')).toBeNull()
    expect(resolveOmniboxInput('   ')).toBeNull()
  })

  it('rejects a search url over the length cap instead of navigating', () => {
    expect(go('x '.repeat(5000))).toEqual({ ok: false, reason: 'too_long' })
  })
})

describe('search engine', () => {
  it.each([
    ['google', 'https://www.google.com/search?q=a%20b'],
    ['duckduckgo', 'https://duckduckgo.com/?q=a%20b'],
    ['bing', 'https://www.bing.com/search?q=a%20b'],
    ['kagi', 'https://kagi.com/search?q=a%20b'],
  ] as const)('%s', (engine, url) => expect(go('a b', engine)).toBe(url))

  it('falls back to google for unknown values and tolerates lone surrogates', () => {
    expect(toSearchEngine('altavista')).toBe('google')
    expect(toSearchEngine(undefined)).toBe('google')
    expect(buildSearchUrl('a\uD800')).toBe('https://www.google.com/search?q=a%EF%BF%BD')
  })

  it('is a persisted setting defaulting to google', () => {
    expect(DEFAULT_SETTINGS.browserSearchEngine).toBe('google')
    expect(mergeSettings({ browserSearchEngine: 'duckduckgo' }).browserSearchEngine).toBe('duckduckgo')
  })
})
