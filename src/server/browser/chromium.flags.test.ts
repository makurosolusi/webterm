import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildChromiumArgs, DENIED_PERMISSIONS, profileDirFor } from './chromium.flags'

const ROOT = '/data/webterm'

describe('profileDirFor', () => {
  it('puts the profile under <dataRoot>/browser/profiles/<id>', () => {
    expect(profileDirFor(ROOT, 'ws_1-A')).toBe(join(resolve(ROOT), 'browser', 'profiles', 'ws_1-A'))
  })
  it.each(['..', '../x', 'a/b', 'a\\b', '', ' ', 'a'.repeat(65), '.hidden', 'x\0y'])('rejects unsafe id %j', (id) => {
    expect(() => profileDirFor(ROOT, id)).toThrow(/unsafe/)
  })
})

describe('buildChromiumArgs', () => {
  const args = buildChromiumArgs({ profileDir: '/data/webterm/browser/profiles/w', proxyServer: 'http://127.0.0.1:4555' })

  it('never disables the sandbox', () => {
    expect(args.join(' ')).not.toMatch(/no-sandbox|disable-setuid-sandbox/)
  })
  it('uses a dedicated user-data-dir, never the default Chrome profile', () => {
    expect(args).toContain('--user-data-dir=/data/webterm/browser/profiles/w')
    expect(args.filter((a) => a.startsWith('--user-data-dir='))).toHaveLength(1)
  })
  it('forces all traffic through the SSRF proxy, loopback included', () => {
    expect(args).toContain('--proxy-server=http://127.0.0.1:4555')
    expect(args).toContain('--proxy-bypass-list=<-loopback>')
  })
  it('exposes CDP only on loopback with an ephemeral port', () => {
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).toContain('--remote-debugging-port=0')
    expect(args.join(' ')).not.toMatch(/0\.0\.0\.0/)
  })
  it('runs headless and denies permission prompts', () => {
    expect(args).toContain('--headless=new')
    expect(args).toContain('--deny-permission-prompts')
    expect(DENIED_PERMISSIONS).toEqual(['camera', 'microphone', 'geolocation', 'notifications'])
  })
  it('turns off Chrome\'s own background calls home (they would egress via the proxy unasked)', () => {
    expect(args).toContain('--disable-background-networking')
    expect(args).toContain('--disable-component-update')
  })
  it('refuses to build without a proxy or profile dir', () => {
    expect(() => buildChromiumArgs({ profileDir: '/p', proxyServer: '' })).toThrow(/proxyServer is required/)
    expect(() => buildChromiumArgs({ profileDir: '', proxyServer: 'http://127.0.0.1:1' })).toThrow(/profileDir is required/)
  })
})
