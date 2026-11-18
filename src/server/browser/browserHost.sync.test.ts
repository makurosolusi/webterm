import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserInputEvent } from '../../shared/browser.contract'
import { splitPane } from '../../shared/browser.layout'
import { CDP } from './cdp.client'
import { SCROLL_SETTLE_MS, SYNC_NEEDS_SPLIT } from './browserHost.sync'
import type { HostEvent } from './browserHost.targets'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })
const callsOf = (m: string, sid: string) => rig.fake.calls.filter((c) => c.method === m && c.sessionId === sid)
const ax = (nodes: Array<[string, string, number]>) => ({ nodes: [{ nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'P' }, backendDOMNodeId: 1, childIds: nodes.map((_, i) => `n${i}`) }, ...nodes.map(([role, name, id], i) => ({ nodeId: `n${i}`, role: { value: role }, name: { value: name }, backendDOMNodeId: id }))] })
const mouse = (type: 'down' | 'up' | 'wheel', tab?: string): BrowserInputEvent => ({ t: 'mouse', type, x: 50, y: 60, button: type === 'wheel' ? 'none' : 'left', buttons: 1, clickCount: 1, mods: 0, dx: 0, dy: type === 'wheel' ? 100 : 0, ...(tab ? { tab } : {}) })
const events: HostEvent[] = []

/** Node with tabs a (S-T1, the view) and b (S-T2) side by side; the source page shows a Buy button (backend 10), the other `other`. */
async function open(other: Array<[string, string, number]>) {
  rig = await makeHostRig(stubGuard())
  events.length = 0
  rig.host.onEvent((e) => events.push(e))
  await rig.host.open('n1', 'w1', 'https://a.test/')
  await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'human' })
  const [a, b] = rig.host.tabsState('n1')!.tabs.map((t) => t.tabId)
  await rig.host.tabApi.setLayout('n1', splitPane(null, a, b, 'right'), a)
  rig.fake.handle('DOM.getNodeForLocation', () => ({ backendNodeId: 10 }))
  rig.fake.handle('Accessibility.getFullAXTree', (_p, sid) => (sid === 'S-T1' ? ax([['button', 'Buy', 10], ['link', 'Docs', 11]]) : ax(other)))
  rig.fake.handle('DOM.getContentQuads', () => ({ quads: [[0, 0, 20, 0, 20, 20, 0, 20]] }))
  rig.fake.handle('DOM.describeNode', () => ({ node: { attributes: [] } }))
  rig.fake.calls.length = 0
  return { a, b }
}

describe('sync mode: switch', () => {
  it('is off by default and refuses to turn on without a split', async () => {
    rig = await makeHostRig(stubGuard())
    await rig.host.open('n1', 'w1', 'https://a.test/')
    expect(rig.host.syncOn('n1')).toBe(false)
    expect(() => rig.host.sync.set('n1', true)).toThrow(SYNC_NEEDS_SPLIT)
  })
  it('announces on/off to viewers and ends when the layout collapses to one pane', async () => {
    const { a } = await open([['button', 'Buy', 20]])
    rig.host.sync.set('n1', true)
    expect(rig.host.syncOn('n1')).toBe(true)
    await rig.host.tabApi.setLayout('n1', null, a)
    expect(rig.host.syncOn('n1')).toBe(false)
    expect(events.filter((e) => e.k === 'sync').map((e) => (e as { on: boolean }).on)).toEqual([true, false])
  })
  it('does nothing while off', async () => {
    await open([['button', 'Buy', 20]])
    await rig.host.input('n1', mouse('down'))
    await new Promise((r) => setTimeout(r, 40))
    expect(callsOf(CDP.mouse, 'S-T2')).toHaveLength(0)
  })
})

describe('sync mode: mirrored actions', () => {
  it('a click lands on the element with the same role, name and place in the other pane', async () => {
    await open([['link', 'Docs', 21], ['button', 'Buy', 20]])
    rig.host.sync.set('n1', true)
    await rig.host.input('n1', mouse('down'))
    await waitFor(() => callsOf(CDP.mouse, 'S-T2').length === 3, 'mirrored move/down/up')
    expect(callsOf('DOM.scrollIntoViewIfNeeded', 'S-T2')[0].params.backendNodeId).toBe(20)
    expect(callsOf(CDP.mouse, 'S-T2').map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(events.some((e) => e.k === 'syncMiss')).toBe(false)
  })
  it('a pane without such an element is marked no match and the click is not sent there', async () => {
    const { b } = await open([['link', 'Docs', 21]])
    rig.host.sync.set('n1', true)
    await rig.host.input('n1', mouse('down'))
    await waitFor(() => events.some((e) => e.k === 'syncMiss'), 'no match')
    expect(events.find((e) => e.k === 'syncMiss')).toMatchObject({ nodeId: 'n1', tab: b, reason: 'no_match' })
    expect(callsOf(CDP.mouse, 'S-T2')).toHaveLength(0)
  })
  it('a failing pane does not break the others or the human input', async () => {
    const { b } = await open([['button', 'Buy', 20]])
    rig.fake.handle('DOM.getContentQuads', (_p, sid) => (sid === 'S-T2' ? { __error: { code: -32000, message: 'boom' } } : {}))
    rig.host.sync.set('n1', true)
    await expect(rig.host.input('n1', mouse('down'))).resolves.toBeUndefined()
    await waitFor(() => events.some((e) => e.k === 'syncMiss'), 'miss for the failing pane')
    expect(events.find((e) => e.k === 'syncMiss')).toMatchObject({ tab: b })
    expect(callsOf(CDP.mouse, 'S-T1').length).toBeGreaterThan(0)
  })
  it('keys typed in one pane are typed in the other', async () => {
    await open([['button', 'Buy', 20]])
    rig.host.sync.set('n1', true)
    await rig.host.input('n1', { t: 'text', text: 'hello' })
    await waitFor(() => callsOf(CDP.insertText, 'S-T2').length === 1, 'mirrored text')
    expect(callsOf(CDP.insertText, 'S-T2')[0].params.text).toBe('hello')
  })
  it('an input from a non-focused pane is mirrored to the other panes, not back to itself', async () => {
    const { a, b } = await open([['button', 'Buy', 20]])
    rig.host.sync.set('n1', true)
    await rig.host.input('n1', { t: 'text', text: 'x', tab: b })
    await waitFor(() => callsOf(CDP.insertText, 'S-T1').length === 1, 'mirrored into the view')
    expect(callsOf(CDP.insertText, 'S-T2')).toHaveLength(1) // its own, once
    expect(a).not.toBe(b)
  })
  it('scroll copies the position as a ratio once the burst settles', async () => {
    await open([['button', 'Buy', 20]])
    rig.fake.handle(CDP.evaluate, (p) => ({ result: { value: String(p.expression).includes('scrollTop') ? 0.5 : 1 } }))
    rig.host.sync.set('n1', true)
    for (let i = 0; i < 3; i++) await rig.host.input('n1', mouse('wheel'))
    await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS + 80))
    const other = callsOf(CDP.evaluate, 'S-T2')
    expect(other).toHaveLength(1)
    expect(String(other[0].params.expression)).toContain('0.5*m')
  })
  it('navigation, reload and back of the focused pane are repeated; stop is not', async () => {
    const { b } = await open([['button', 'Buy', 20]])
    rig.fake.handle(CDP.getNavigationHistory, () => ({ currentIndex: 1, entries: [{ id: 7 }, { id: 8 }, { id: 9 }] }))
    rig.host.sync.set('n1', true)
    await rig.host.navAction('n1', 'go', 'https://c.test/')
    await waitFor(() => callsOf(CDP.navigate, 'S-T2').some((c) => c.params.url === 'https://c.test/'), 'mirrored go')
    await rig.host.navAction('n1', 'reload')
    await waitFor(() => callsOf(CDP.reload, 'S-T2').length === 1, 'mirrored reload')
    await rig.host.navAction('n1', 'back')
    await waitFor(() => callsOf(CDP.navigateToHistoryEntry, 'S-T2').length === 1, 'mirrored back')
    expect(callsOf(CDP.navigateToHistoryEntry, 'S-T2')[0].params.entryId).toBe(7)
    await rig.host.navAction('n1', 'stop')
    await new Promise((r) => setTimeout(r, 30))
    expect(callsOf(CDP.stopLoading, 'S-T2')).toHaveLength(0)
    expect(b).toBeTruthy()
  })
  it('a mirrored navigation to a blocked address is refused by the same guard and marked on that pane', async () => {
    rig = await makeHostRig(stubGuard(['evil.test']))
    events.length = 0
    rig.host.onEvent((e) => events.push(e))
    await rig.host.open('n1', 'w1', 'https://a.test/')
    await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'human' })
    const [a, b] = rig.host.tabsState('n1')!.tabs.map((t) => t.tabId)
    await rig.host.tabApi.setLayout('n1', splitPane(null, a, b, 'right'), a)
    rig.host.sync.set('n1', true)
    rig.fake.calls.length = 0
    rig.host.sync.onNav('n1', 'go', 'http://evil.test/')
    await waitFor(() => events.some((e) => e.k === 'syncMiss'), 'blocked pane is marked')
    expect(callsOf(CDP.navigate, 'S-T2')).toHaveLength(0)
  })
})
