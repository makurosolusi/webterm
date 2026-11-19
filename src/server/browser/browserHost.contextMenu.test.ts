// Guards of the canvas browser's own context menu: the right button never reaches Chromium (no native menu), the page's
// answer is sanitized, hit-tests are rate limited, middle/Ctrl+click on a link becomes a tab of the node.
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserInputEvent } from '../../shared/browser.contract'
import type { HostEvent } from './browserHost.service'
import { CTX_RATE_MAX } from './browserHost.contextMenu'
import { BACKSTOP_SCRIPT } from './browserHost.contextMenu.script'
import { CDP } from './cdp.client'
import { makeHostRig, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })
const SID = 'S-T1'
const callsOf = (m: string) => rig.fake.calls.filter((c) => c.method === m)
const hitTests = () => callsOf(CDP.evaluate).filter((c) => String(c.params.expression).includes('elementFromPoint'))
const menus = (ev: HostEvent[]) => ev.filter((e): e is Extract<HostEvent, { k: 'contextMenu' }> => e.k === 'contextMenu')
const mouse = (type: 'down' | 'up', button: 'left' | 'middle' | 'right', mods = 0): BrowserInputEvent =>
  ({ t: 'mouse', type, x: 40, y: 50, button, buttons: type === 'down' ? 2 : 0, clickCount: 1, mods, dx: 0, dy: 0 })
const answer = (value: unknown) => rig.fake.handle(CDP.evaluate, (p) => (String(p.expression).includes('elementFromPoint') ? { result: { type: 'string', value: typeof value === 'string' ? value : JSON.stringify(value) } } : {}))

async function open() {
  rig = await makeHostRig()
  const events: HostEvent[] = []
  rig.host.onEvent((e) => events.push(e))
  await rig.host.open('n1', 'w1', 'https://a.test/')
  return events
}

describe('right click never reaches Chromium', () => {
  it('installs the backstop script on the page before it navigates, in every frame it covers', async () => {
    await open()
    const call = callsOf(CDP.addScript)[0]
    expect(call.sessionId).toBe(SID)
    expect(call.params.source).toBe(BACKSTOP_SCRIPT)
    expect(BACKSTOP_SCRIPT).toContain('contextmenu')
    expect(BACKSTOP_SCRIPT).toContain('auxclick')
    const m = rig.fake.methods()
    expect(m.indexOf(CDP.addScript)).toBeLessThan(m.indexOf(CDP.navigate))
  })

  it('drops the right button down and up (no Input.dispatchMouseEvent) and reports what is under the pointer', async () => {
    const ev = await open()
    answer({ link: { href: 'https://l.test/x', text: '  Read\n more ' }, image: 'https://l.test/i.png', selection: true, editable: false })
    await rig.host.input('n1', mouse('down', 'right'))
    await rig.host.input('n1', mouse('up', 'right'))
    await waitFor(() => menus(ev).length === 1, 'context menu event')
    expect(callsOf(CDP.mouse)).toHaveLength(0)
    expect(menus(ev)[0].info).toEqual({ link: { href: 'https://l.test/x', text: 'Read more' }, image: 'https://l.test/i.png', selection: true, editable: false })
    expect(String(hitTests()[0].params.expression)).toContain("'contextmenu'") // the site gets its own event first
  })

  it('shows no webterm menu when the site cancelled its contextmenu event (its own menu wins)', async () => {
    const ev = await open()
    answer({ custom: true })
    await rig.host.input('n1', mouse('down', 'right'))
    await waitFor(() => hitTests().length === 1, 'hit test')
    await new Promise((r) => setTimeout(r, 30))
    expect(menus(ev)).toHaveLength(0)
    expect(callsOf(CDP.mouse)).toHaveLength(0)
  })

  it('treats the page answer as untrusted: only http(s) addresses survive, text is capped', async () => {
    const ev = await open()
    answer({ link: { href: 'javascript:alert(1)', text: 'x'.repeat(5000) }, image: 'data:image/png;base64,AAAA', selection: 'yes', editable: 1 })
    await rig.host.input('n1', mouse('down', 'right'))
    await waitFor(() => menus(ev).length === 1, 'context menu event')
    expect(menus(ev)[0].info).toEqual({ selection: false, editable: false })
  })

  it('answers garbage with no menu and rate limits hit-tests', async () => {
    const ev = await open()
    answer('not json')
    for (let i = 0; i < CTX_RATE_MAX * 3; i++) await rig.host.input('n1', mouse('down', 'right'))
    await waitFor(() => hitTests().length === CTX_RATE_MAX, 'rate limited hit tests')
    await new Promise((r) => setTimeout(r, 30))
    expect(hitTests()).toHaveLength(CTX_RATE_MAX)
    expect(menus(ev)).toHaveLength(0)
  })
})

describe('middle and Ctrl/Cmd+click on a link stay on the canvas', () => {
  it('forwards the click and opens the link as a tab of the node', async () => {
    await open()
    answer({ link: { href: 'https://l.test/new', text: 'go' }, selection: false, editable: false })
    await rig.host.input('n1', mouse('down', 'middle'))
    await waitFor(() => rig.host.tabsState('n1')!.tabs.some((t) => t.url === 'https://l.test/new'), 'tab opened')
    await waitFor(() => callsOf(CDP.mouse).length > 0, 'forwarded click') // pages with their own middle-button handling still get it
    await rig.host.input('n1', mouse('down', 'left', 2))
    await waitFor(() => hitTests().length === 2, 'second hit test')
  })

  it('does nothing extra for a plain left click', async () => {
    await open()
    await rig.host.input('n1', mouse('down', 'left'))
    await waitFor(() => callsOf(CDP.mouse).length === 1, 'forwarded click')
    expect(hitTests()).toHaveLength(0)
  })

  it('refuses a non-http address from the client action', async () => {
    await open()
    await expect(rig.host.ctxMenu.openLink('n1', 'javascript:alert(1)')).rejects.toThrow(/non-http/)
    await expect(rig.host.ctxMenu.openLink('n1', 'file:///etc/passwd')).rejects.toThrow(/non-http/)
  })
})
