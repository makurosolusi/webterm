import { afterEach, describe, expect, it } from 'vitest'
import type { Frame } from '../../shared/browser.contract'
import type { PersistedTabs } from '../../shared/browser.tabs'
import { layoutTabIds, splitPane } from '../../shared/browser.layout'
import { CDP, CDP_EVENT } from './cdp.client'
import { SIDE_EVERY_NTH, CROWDED_SCALE } from './browserHost.split'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })
const callsOf = (m: string, sid?: string) => rig.fake.calls.filter((c) => c.method === m && (sid === undefined || c.sessionId === sid))
const tabs = () => rig.host.tabsState('n1')!
const frames: Frame[] = []
const frame = (sid: string, ackId = 1) => rig.fake.emit(CDP_EVENT.screencastFrame, { data: 'AAAA', sessionId: ackId, metadata: {} }, sid)

/** Node with tabs a (T1), b (T2), c (T3), the human on c; a viewer streaming. */
async function open(extra: Parameters<typeof makeHostRig>[1] = {}) {
  rig = await makeHostRig(stubGuard(), extra)
  frames.length = 0
  await rig.host.open('n1', 'w1', 'https://a.test/')
  await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'human' })
  await rig.host.tabApi.newTab('n1', { url: 'https://c.test/', by: 'human' })
  await rig.host.startScreencast('n1', (f) => frames.push(f))
  const [a, b, c] = tabs().tabs.map((t) => t.tabId)
  return { a, b, c }
}
const sidOf = (tabId: string) => `S-T${tabs().tabs.findIndex((t) => t.tabId === tabId) + 1}`

describe('on-screen tabs stream, the rest do not', () => {
  it('starts a low-rate screencast for the non-focused pane only, none for hidden tabs', async () => {
    const { a, b, c } = await open()
    rig.fake.calls.length = 0
    await rig.host.setView('n1', [a, c], c)
    const side = callsOf(CDP.startScreencast, sidOf(a))
    expect(side).toHaveLength(1)
    expect(side[0].params.everyNthFrame).toBe(SIDE_EVERY_NTH)
    expect(callsOf(CDP.startScreencast, sidOf(b))).toHaveLength(0)
  })

  it('tags frames with their tab in a split and acks each frame on its own page', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    frame(sidOf(c), 11)
    frame(sidOf(a), 22)
    await waitFor(() => frames.length === 2, 'two frames')
    expect(frames.map((f) => f.tabId)).toEqual([c, a])
    rig.fake.calls.length = 0
    rig.host.ackFrame('n1', frames[1].seq)
    rig.host.ackFrame('n1', frames[0].seq)
    await waitFor(() => callsOf(CDP.screencastFrameAck).length === 2, 'acks')
    expect(callsOf(CDP.screencastFrameAck).map((x) => [x.sessionId, x.params.sessionId])).toEqual([[sidOf(a), 22], [sidOf(c), 11]])
  })

  it('a single pane keeps plain frames (no tab tag) and starts nothing extra', async () => {
    await open()
    frame(sidOf(tabs().activeTabId as string), 5)
    await waitFor(() => frames.length === 1, 'frame')
    expect(frames[0].tabId).toBeUndefined()
  })

  it('moving focus swaps who is the view; the old view keeps streaming as a side pane', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.setView('n1', [a, c], a)
    expect(tabs().activeTabId).toBe(a)
    expect(callsOf(CDP.startScreencast, sidOf(c)).at(-1)?.params.everyNthFrame).toBe(SIDE_EVERY_NTH)
    expect(callsOf(CDP.startScreencast, sidOf(a)).at(-1)?.params.everyNthFrame).toBeUndefined()
  })

  it('shrinking the on-screen set stops the screencast of the tab that left', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.setView('n1', [c], c)
    expect(callsOf(CDP.stopScreencast, sidOf(a))).toHaveLength(1)
    frame(sidOf(a), 9)
    await new Promise((r) => setTimeout(r, 30))
    expect(frames).toHaveLength(0) // a stray late frame of the stopped pane is dropped
  })

  it('more than two panes shrink the unfocused frames', async () => {
    const { a, b, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    const two = callsOf(CDP.startScreencast, sidOf(a)).at(-1)?.params.maxWidth as number
    await rig.host.setView('n1', [a, b, c], c)
    const three = callsOf(CDP.startScreencast, sidOf(a)).at(-1)?.params.maxWidth as number
    expect(three).toBe(Math.round(two * CROWDED_SCALE))
  })

  it('stopping the stream stops every pane', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.stopScreencast('n1')
    expect(callsOf(CDP.stopScreencast, sidOf(a))).toHaveLength(1)
  })
})

describe('robustness', () => {
  it('a view or pane size for a node without a page is a quiet no-op, not an error', async () => {
    rig = await makeHostRig(stubGuard())
    await expect(rig.host.setView('ghost', ['x'], 'x')).resolves.toBeUndefined()
    await expect(rig.host.setTabViewport('ghost', 'x', 100, 100, 1)).resolves.toBeUndefined()
  })

  it('a crashed pane is not rebuilt behind the user: it stays crashed until Reload', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.emit(CDP_EVENT.targetCrashed, { targetId: 'T1' })
    await waitFor(() => tabs().tabs.find((t) => t.tabId === a)?.crashed === true, 'a crashed')
    const spawned = callsOf(CDP.createTarget).length
    await rig.host.setView('n1', [a, c], c)
    expect(callsOf(CDP.createTarget)).toHaveLength(spawned)
    expect(tabs().tabs.find((t) => t.tabId === a)?.crashed).toBe(true)
  })
})

describe('input goes to the pane it was made in', () => {
  const click = (tab: string) => ({ t: 'mouse' as const, type: 'down' as const, x: 5, y: 6, button: 'left' as const, buttons: 1, clickCount: 1, mods: 0, dx: 0, dy: 0, tab })
  it('a mouse event with another tab id reaches that page and not the view', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.input('n1', click(a))
    await waitFor(() => callsOf(CDP.mouse).length > 0, 'mouse sent')
    expect(callsOf(CDP.mouse).every((x) => x.sessionId === sidOf(a))).toBe(true)
    rig.fake.calls.length = 0
    await rig.host.input('n1', click(c))
    await waitFor(() => callsOf(CDP.mouse).length > 0, 'mouse sent to the view')
    expect(callsOf(CDP.mouse).every((x) => x.sessionId === sidOf(c))).toBe(true)
  })
})

describe('viewport and device per tab', () => {
  it('a tab device reaches only that page, and restarts only its stream at the device size', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.setTabDevice('n1', a, { id: 'custom', w: 390, h: 844, dpr: 2 })
    expect(callsOf(CDP.setDeviceMetrics).map((x) => [x.sessionId, x.params.width, x.params.height])).toEqual([[sidOf(a), 390, 844]])
    expect(callsOf(CDP.startScreencast, sidOf(a)).at(-1)?.params).toMatchObject({ maxWidth: 780, maxHeight: 1688 })
    expect(tabs().tabs.find((t) => t.tabId === a)?.device).toEqual({ id: 'custom', w: 390, h: 844, dpr: 2 })
    expect(tabs().tabs.find((t) => t.tabId === c)?.device).toBeUndefined()
  })

  it('a pane size sets that page only; clearing the device returns it to the pane size', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.setTabViewport('n1', a, 500, 300, 1)
    expect(callsOf(CDP.setDeviceMetrics).map((x) => [x.sessionId, x.params.width, x.params.height])).toEqual([[sidOf(a), 500, 300]])
    await rig.host.setTabDevice('n1', a, { id: 'custom', w: 390, h: 844, dpr: 1 })
    rig.fake.calls.length = 0
    await rig.host.setTabDevice('n1', a, null)
    expect(callsOf(CDP.setDeviceMetrics).at(-1)?.params).toMatchObject({ width: 500, height: 300 })
    expect(callsOf(CDP.setUserAgent).at(-1)?.params.userAgent).toBe('')
  })

  it('the node-level size no longer reaches a view that has its own pane size', async () => {
    const { c } = await open()
    await rig.host.setTabViewport('n1', c, 400, 300, 1)
    rig.fake.calls.length = 0
    await rig.host.setViewport('n1', 900, 700, 1)
    expect(callsOf(CDP.setDeviceMetrics)).toHaveLength(0)
  })

  it('a preset with another identity reloads that page only', async () => {
    const { a, c } = await open()
    await rig.host.setView('n1', [a, c], c)
    rig.fake.calls.length = 0
    await rig.host.setTabDevice('n1', a, { id: 'ipad-mini' })
    expect(callsOf(CDP.reload, sidOf(a))).toHaveLength(1)
    expect(callsOf(CDP.reload, sidOf(c))).toHaveLength(0)
  })
})

describe('layout', () => {
  it('stores a layout, emits it, and the on-screen set follows it', async () => {
    const { a, c } = await open()
    const events: string[] = []
    rig.host.onEvent((e) => { if (e.k === 'tab') events.push(e.event.type) })
    await rig.host.setLayout('n1', splitPane(null, a, c, 'right'), c)
    expect(layoutTabIds(tabs().layout as never)).toEqual([a, c])
    expect(events).toContain('layoutChanged')
    expect(callsOf(CDP.startScreencast, sidOf(a)).at(-1)?.params.everyNthFrame).toBe(SIDE_EVERY_NTH)
  })

  it('rejects a layout with a tab that does not exist', async () => {
    const { a } = await open()
    await expect(rig.host.setLayout('n1', splitPane(null, a, 'ghost', 'right'))).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('closing a shown tab gives its pane to the nearest hidden tab, or collapses the pane', async () => {
    const { a, b, c } = await open()
    await rig.host.setLayout('n1', splitPane(null, a, c, 'right'), c)
    await rig.host.tabApi.closeTab('n1', c)
    expect(layoutTabIds(tabs().layout as never)).toEqual([a, b]) // b was hidden: it fills the pane
    await rig.host.tabApi.closeTab('n1', b)
    expect(tabs().layout).toBeUndefined() // nothing left to show beside a: back to one pane
    expect(tabs().activeTabId).toBe(a)
  })

  it('activating a hidden tab in a split takes over the focused pane', async () => {
    const { a, b, c } = await open()
    await rig.host.setLayout('n1', splitPane(null, a, c, 'right'), c)
    await rig.host.tabApi.activate('n1', b, 'human')
    expect(layoutTabIds(tabs().layout as never)).toEqual([a, b])
  })

  it('unsplitting forgets pane sizes: the page follows the node again', async () => {
    const { a, c } = await open()
    await rig.host.setLayout('n1', splitPane(null, a, c, 'right'), c)
    await rig.host.setTabViewport('n1', c, 300, 200, 1)
    await rig.host.setLayout('n1', null)
    rig.fake.calls.length = 0
    await rig.host.setViewport('n1', 800, 600, 1)
    expect(callsOf(CDP.setDeviceMetrics).at(-1)?.params).toMatchObject({ width: 800, height: 600 })
  })
})

describe('persistence', () => {
  it('saves layout and per-tab device with the tab list', async () => {
    const saved: Array<PersistedTabs | null> = []
    const { a, c } = await open({ persistTabs: (_id, t) => { saved.push(t) } })
    await rig.host.setLayout('n1', splitPane(null, a, c, 'right'), c)
    await rig.host.setTabDevice('n1', a, { id: 'custom', w: 390, h: 844, dpr: 2 })
    await waitFor(() => saved.some((s) => s?.layout && s.tabs.find((t) => t.tabId === a)?.device), 'saved', 4000)
    const last = saved.filter(Boolean).at(-1) as PersistedTabs
    expect(layoutTabIds(last.layout as never)).toEqual([a, c])
    expect(last.tabs.find((t) => t.tabId === a)?.device).toEqual({ id: 'custom', w: 390, h: 844, dpr: 2 })
    expect(last.tabs.find((t) => t.tabId === c)?.device).toBeUndefined()
  })

  it('restores the saved layout and devices when the node opens again; a board without them is one pane', async () => {
    const board: PersistedTabs = {
      tabs: [{ tabId: 'ta', url: 'https://a.test/', title: '' }, { tabId: 'tb', url: 'https://b.test/', title: '', device: { id: 'custom', w: 390, h: 844, dpr: 2 } }],
      activeTabId: 'ta', agentTabId: 'ta', layout: { dir: 'v', ratio: 0.4, a: { id: 'ta' }, b: { id: 'tb' } },
    }
    rig = await makeHostRig(stubGuard(), { initialTabs: () => board })
    await rig.host.open('n1', 'w1')
    expect(tabs().layout).toEqual(board.layout)
    expect(tabs().tabs[1].device).toEqual({ id: 'custom', w: 390, h: 844, dpr: 2 })
    await rig.stop()
    const { layout: _l, ...old } = board
    rig = await makeHostRig(stubGuard(), { initialTabs: () => old })
    await rig.host.open('n1', 'w1')
    expect(tabs().layout).toBeUndefined()
  })
})
