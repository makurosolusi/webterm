import { describe, expect, it } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import { BLANK_URL, createNavigationGuard } from './navigation.guard'
import { parseAllowHosts } from './ssrf.allowlist'

const SELF = 8700
const allow = (raw: string) => {
  const r = parseAllowHosts(raw, SELF)
  if (!r.ok) throw new Error(r.reason)
  return r.hosts
}
const guard = createNavigationGuard({ allow: allow('dev.local:3000,127.0.0.1:5173'), webtermPort: SELF })

describe('navigation.guard check', () => {
  it('lolos: host publik, IP publik, host allowlist (juga loopback)', () => {
    for (const u of ['https://example.com/a?b=1', 'http://93.184.216.34/', 'http://dev.local:3000/', 'http://127.0.0.1:5173/']) {
      expect(guard.check(u).ok).toBe(true)
    }
  })

  it.each([
    ['http://127.0.0.1/', 'private_host'], ['http://localhost:3000/', 'private_host'], ['http://a.localhost/', 'private_host'],
    ['http://[::1]/', 'private_host'], ['http://169.254.169.254/latest/meta-data', 'private_host'],
    ['http://10.0.0.1/', 'private_host'], ['http://[::ffff:127.0.0.1]/', 'private_host'],
    ['http://2130706433/', 'private_host'], ['http://0x7f.1/', 'private_host'], ['http://0/', 'private_host'],
    ['http://dev.local:3001/', 'ok'], // host allowlist bukan IP -> tanpa DNS lolos lapis-1; proxy yang menjaga
    [`http://127.0.0.1:${SELF}/`, 'not_allowed_port'], [`http://localhost:${SELF}/`, 'not_allowed_port'],
    ['file:///etc/passwd', 'scheme'], ['javascript:alert(1)', 'scheme'], ['data:text/html,x', 'scheme'],
    ['chrome://settings', 'scheme'], ['view-source:http://a.com', 'scheme'], ['devtools://x', 'scheme'],
    ['http://user:pw@example.com/', 'scheme'], ['not a url', 'scheme'],
  ])('%s -> %s', (url, expected) => {
    const r = guard.check(url)
    expect(r.ok ? 'ok' : r.reason).toBe(expected)
  })

  it('port webterm di-hard-deny walau host:port ada di allow set', () => {
    const g = createNavigationGuard({ allow: new Set([`127.0.0.1:${SELF}`]), webtermPort: SELF })
    const r = g.check(`http://127.0.0.1:${SELF}/`)
    expect(r.ok ? 'ok' : r.reason).toBe('not_allowed_port')
  })

  it('penolakan hanya memuat hostname, tanpa URL/query/credential', () => {
    const r = guard.check('http://user:secret@evil.test/p?token=abc')
    expect(JSON.stringify(r)).not.toMatch(/secret|token|\/p/)
    const e = guard.check('http://10.0.0.5/x?token=abc')
    expect(JSON.stringify(e)).not.toContain('token')
  })
})

describe('assert / onFrameNavigated', () => {
  it('assert melempar BlockedError dengan reason+hostname, mengembalikan URL ternormalisasi bila lolos', () => {
    expect(guard.assert('https://Example.com')).toBe('https://example.com/')
    try {
      guard.assert('http://169.254.169.254/x')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedError)
      expect((err as BlockedError).reason).toBe('private_host')
      expect((err as BlockedError).hostname).toBe('169.254.169.254')
      expect((err as BlockedError).message).not.toContain('/x')
    }
  })

  it('onFrameNavigated: about:blank lolos; redirect ke host privat/skema buruk gagal', () => {
    expect(guard.onFrameNavigated(BLANK_URL).ok).toBe(true)
    expect(guard.onFrameNavigated('https://example.com/').ok).toBe(true)
    expect(guard.onFrameNavigated('http://192.168.0.1/').ok).toBe(false)
    expect(guard.onFrameNavigated('file:///etc/passwd').ok).toBe(false)
  })
})

describe('navigation.guard bind loopback (dev server lokal)', () => {
  const g = createNavigationGuard({ allow: new Set(), webtermPort: SELF, allowLoopback: true })
  it.each([
    ['http://localhost:3000/', 'ok'], ['http://127.0.0.1:5173/', 'ok'], ['http://[::1]:8080/', 'ok'],
    [`http://localhost:${SELF}/`, 'not_allowed_port'], [`http://127.0.0.1:${SELF}/`, 'not_allowed_port'],
    ['http://10.0.0.1/', 'private_host'], ['http://192.168.1.5:3000/', 'private_host'], ['http://169.254.169.254/', 'private_host'],
  ])('%s -> %s', (url, expected) => {
    const r = g.check(url)
    expect(r.ok ? 'ok' : r.reason).toBe(expected)
  })

  it('tanpa allowLoopback (bind terekspos) localhost tetap diblokir', () => {
    const r = createNavigationGuard({ allow: new Set(), webtermPort: SELF }).check('http://localhost:3000/')
    expect(r.ok ? 'ok' : r.reason).toBe('private_host')
  })

  it('allowlist getter dibaca ulang tiap cek', () => {
    let cur: ReadonlySet<string> = new Set()
    const live = createNavigationGuard({ allow: () => cur, webtermPort: SELF })
    expect(live.check('http://localhost:3000/').ok).toBe(false)
    cur = allow('localhost:3000')
    expect(live.check('http://localhost:3000/').ok).toBe(true)
  })
})
