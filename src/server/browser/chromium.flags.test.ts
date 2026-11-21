import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildChromiumArgs, DENIED_PERMISSIONS, headlessReason, profileDirFor, windowPlacement } from './chromium.flags'

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
  it('runs headful off-screen without automation tells (Orca offscreen backend) and denies permission prompts', () => {
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false)
    expect(args).toContain('--window-position=-32000,-32000')
    expect(args).toContain('--window-size=1280,800')
    expect(args).toContain('--disable-blink-features=AutomationControlled')
    for (const f of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']) expect(args).toContain(f)
    expect(args.join(' ')).not.toMatch(/--user-agent=/)
    expect(args).toContain('--mute-audio') // the server's speakers stay silent; sound reaches the client through the in-page capture
    expect(args).toContain('--deny-permission-prompts')
    expect(DENIED_PERMISSIONS).toEqual(['camera', 'microphone', 'geolocation', 'notifications'])
  })
  it('turns off Chrome\'s own background calls home (they would egress via the proxy unasked)', () => {
    expect(args).toContain('--disable-background-networking')
    expect(args).toContain('--disable-component-update')
  })
  it('headless fallback swaps the window flags for --headless=new, keeping the rest', () => {
    const h = buildChromiumArgs({ profileDir: '/p', proxyServer: 'http://127.0.0.1:1', headless: true })
    expect(h).toContain('--headless=new')
    expect(h.some((a) => a.startsWith('--window-position'))).toBe(false)
    expect(h).toContain('--disable-blink-features=AutomationControlled')
  })
  it('refuses to build without a proxy or profile dir', () => {
    expect(() => buildChromiumArgs({ profileDir: '/p', proxyServer: '' })).toThrow(/proxyServer is required/)
    expect(() => buildChromiumArgs({ profileDir: '', proxyServer: 'http://127.0.0.1:1' })).toThrow(/profileDir is required/)
  })
})

describe('headlessReason', () => {
  it('defaults to headful on macOS and on Linux with a display', () => {
    expect(headlessReason({}, 'darwin')).toBeNull()
    expect(headlessReason({ DISPLAY: ':0' }, 'linux')).toBeNull()
    expect(headlessReason({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeNull()
  })
  it('falls back on Linux without a display, or when forced by env', () => {
    expect(headlessReason({}, 'linux')).toBe('no_display')
    expect(headlessReason({ WEBTERM_BROWSER_HEADLESS: 'on' }, 'darwin')).toBe('env')
    expect(headlessReason({ WEBTERM_BROWSER_HEADLESS: 'off' }, 'darwin')).toBeNull()
  })
})

describe('startup window and per-node window placement (macOS clamps off-screen windows and the start window steals focus)', () => {
  const base = { profileDir: '/p', proxyServer: 'http://127.0.0.1:1' }
  it('macOS starts without a window; other OSes keep the about:blank start tab as keep-alive', () => {
    const mac = buildChromiumArgs({ ...base, platform: 'darwin' })
    expect(mac).toContain('--no-startup-window')
    expect(mac).not.toContain('about:blank')
    const linux = buildChromiumArgs({ ...base, platform: 'linux' })
    expect(linux).toContain('about:blank')
    expect(linux).not.toContain('--no-startup-window')
  })
  it('every node window is created in the background without focus: minimized on macOS, off-screen elsewhere', () => {
    expect(windowPlacement('darwin')).toEqual({ newWindow: true, background: true, focus: false, windowState: 'minimized' })
    expect(windowPlacement('linux')).toEqual({ newWindow: true, background: true, focus: false, left: -32000, top: -32000, width: 1280, height: 800 })
  })
})
