// The launch line is a CLOSED list: a new Chromium flag needs a deliberate entry here and a row in
// docs/decisions/browser-fingerprint.md. Flags that mark the browser as automated or make it unlike the Chrome a person
// installs (--enable-automation, --user-agent, --no-sandbox, --disable-web-security, --password-store, ...) are not on it.
import { describe, expect, it } from 'vitest'
import { buildChromiumArgs } from './chromium.flags'

/** Flag name (before `=`) -> why it is there. */
const KNOWN: Record<string, string> = {
  '--window-position': 'offscreen window', '--window-size': 'offscreen window',
  '--disable-backgrounding-occluded-windows': 'offscreen window keeps rendering', '--disable-renderer-backgrounding': 'offscreen window keeps rendering',
  '--disable-background-timer-throttling': 'offscreen window keeps rendering',
  '--user-data-dir': 'webterm-owned profile, cookies persist per profile', '--proxy-server': 'SSRF filter, plain CONNECT tunnel',
  '--proxy-bypass-list': 'loopback goes through the SSRF proxy too',
  '--remote-debugging-address': 'CDP on loopback', '--remote-debugging-port': 'CDP on an ephemeral port',
  '--force-webrtc-ip-handling-policy': 'no UDP around the proxy', '--deny-permission-prompts': 'no prompt can be answered offscreen',
  '--disable-background-networking': 'no unasked calls home', '--disable-component-update': 'no unasked calls home',
  '--no-first-run': 'no first-run page', '--no-default-browser-check': 'no default-browser prompt', '--disable-extensions': 'nothing injects into pages',
  '--no-startup-window': 'macOS: no focus-stealing start window', 'about:blank': 'keep-alive start tab (not macOS)', '--headless': 'only the explicit fallback',
  // Decision pending, see docs/decisions/browser-fingerprint.md row F1: this one makes navigator.webdriver read false while CDP is attached.
  '--disable-blink-features': 'navigator.webdriver (owner decision pending)',
}
const FORBIDDEN = ['--enable-automation', '--user-agent', '--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--ignore-certificate-errors',
  '--password-store', '--use-mock-keychain', '--disable-features', '--enable-features', '--enable-blink-features', '--load-extension', '--incognito',
  '--lang', '--accept-lang', '--disable-gpu', '--test-type', '--disable-infobars', '--disable-popup-blocking', '--allow-running-insecure-content']

const variants: Array<[string, string[]]> = [
  ['macOS headful', buildChromiumArgs({ profileDir: '/p', proxyServer: 'http://127.0.0.1:1', platform: 'darwin' })],
  ['linux headful', buildChromiumArgs({ profileDir: '/p', proxyServer: 'http://127.0.0.1:1', platform: 'linux' })],
  ['headless fallback', buildChromiumArgs({ profileDir: '/p', proxyServer: 'http://127.0.0.1:1', headless: true, platform: 'linux' })],
]

describe.each(variants)('launch flags (%s)', (_name, args) => {
  it('every flag is on the known list', () => {
    const unknown = args.filter((a) => !Object.hasOwn(KNOWN, a.split('=')[0]))
    expect(unknown).toEqual([])
  })
  it('carries none of the flags that mark automation or change what Chrome is', () => {
    expect(args.filter((a) => FORBIDDEN.includes(a.split('=')[0]))).toEqual([])
  })
})

it('headless is only ever the explicit fallback', () => {
  expect(variants[0][1].some((a) => a.startsWith('--headless'))).toBe(false)
  expect(variants[2][1]).toContain('--headless=new')
})
