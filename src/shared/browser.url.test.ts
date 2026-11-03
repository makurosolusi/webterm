import { describe, it, expect } from 'vitest'
import { hostOnly, parseBrowserUrl, HOST_INVALID } from './browser.url'

describe('parseBrowserUrl', () => {
  it.each([
    'file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
    'data:text/html,<script>1</script>', 'view-source:https://a.com', 'devtools://devtools/bundled/inspector.html',
    'about:blank', 'ftp://a.com/x', 'blob:https://a.com/uuid',
  ])('tolak skema non-http(s): %s', (u) => {
    expect(parseBrowserUrl(u)).toEqual({ ok: false, reason: 'scheme' })
  })

  it('tolak userinfo (user atau user:pass) tanpa membocorkannya di hasil', () => {
    for (const u of ['https://user:s3cret@a.com/', 'http://user@a.com/']) {
      const r = parseBrowserUrl(u)
      expect(r).toEqual({ ok: false, reason: 'userinfo' })
      expect(JSON.stringify(r)).not.toContain('s3cret')
    }
  })

  it('tolak non-string, kosong, tanpa skema, dan terlalu panjang', () => {
    expect(parseBrowserUrl(undefined)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseBrowserUrl(42)).toEqual({ ok: false, reason: 'invalid' })
    expect(parseBrowserUrl('')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseBrowserUrl('example.com')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseBrowserUrl('https://a.com/' + 'x'.repeat(9000))).toEqual({ ok: false, reason: 'too_long' })
  })

  it('terima http(s), normalisasi, host tanpa port', () => {
    expect(parseBrowserUrl('https://A.com:8443/x?q=1#f')).toEqual({ ok: true, url: 'https://a.com:8443/x?q=1#f', host: 'a.com' })
    expect(parseBrowserUrl('  HTTP://example.org ')).toEqual({ ok: true, url: 'http://example.org/', host: 'example.org' })
    expect(parseBrowserUrl('http://[::1]:3000/')).toMatchObject({ ok: true, host: '[::1]' })
  })
})

describe('hostOnly', () => {
  it('hanya hostname: tanpa skema, port, path, query, fragment, credential', () => {
    expect(hostOnly('https://a.com/x?token=1')).toBe('a.com')
    const out = hostOnly('https://user:pw@a.com:8443/p/a/t/h?token=SECRET#frag')
    expect(out).toBe('a.com')
    for (const leak of ['pw', 'SECRET', 'token', '8443', 'frag', 'user']) expect(out).not.toContain(leak)
  })

  it('input tak terurai tidak di-echo', () => {
    expect(hostOnly('not a url?token=SECRET')).toBe(HOST_INVALID)
    expect(hostOnly('')).toBe(HOST_INVALID)
  })
})
