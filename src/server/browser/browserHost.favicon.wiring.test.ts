// Favicons through the real host with a fake CDP: page load events trigger the read, the icon lands on the tab,
// stays out of the board and out of what agents see.
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedTabs } from '../../shared/browser.tabs'
import { tabViews } from '../../shared/browser.agentTabs'
import { CDP, CDP_EVENT } from './cdp.client'
import { FAVICON_BINDING } from './browser.favicon.script'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`
const SLOW = 3000 // two debounces (500 ms) plus slack on a loaded machine

async function open() {
  const saved: Array<PersistedTabs | null> = []
  rig = await makeHostRig(stubGuard(), { persistTabs: (_id, tabs) => { saved.push(tabs) } })
  rig.fake.handle(CDP.evaluate, () => ({ result: { value: JSON.stringify([{ rel: 'icon', href: 'https://a.test/fav.png', sizes: '32x32' }]) } }))
  rig.fake.handle(CDP.getFrameTree, () => ({ frameTree: { frame: { id: 'F1' } } }))
  rig.fake.handle(CDP.loadNetworkResource, () => ({ resource: { success: true, httpStatusCode: 200, stream: 'H1' } }))
  rig.fake.handle(CDP.ioRead, () => ({ data: PNG.toString('base64'), base64Encoded: true, eof: true }))
  await rig.host.open('n1', 'w1', 'https://a.test/')
  return saved
}
const tabsOf = () => rig.host.tabsState('n1')!
const loadCycle = (sid: string) => {
  rig.fake.emit(CDP_EVENT.frameStartedLoading, { frameId: 'F' }, sid)
  rig.fake.emit(CDP_EVENT.frameStoppedLoading, { frameId: 'F' }, sid)
}

describe('favicon wiring', () => {
  it('a finished load of the view tab fills its icon; the board gets the url only', async () => {
    const saved = await open()
    loadCycle('S-T1')
    await waitFor(() => !!tabsOf().tabs[0].faviconData, 'view tab icon', SLOW)
    expect(tabsOf().tabs[0]).toMatchObject({ favicon: 'https://a.test/fav.png', faviconData: PNG_URI })
    await rig.host.dispose()
    const last = saved.at(-1)
    expect(last?.tabs[0].favicon).toBe('https://a.test/fav.png')
    expect(JSON.stringify(saved)).not.toContain('data:image')
  })

  it('agents never see the icon: the tab view is a whitelist without favicon fields', async () => {
    await open()
    loadCycle('S-T1')
    await waitFor(() => !!tabsOf().tabs[0].faviconData, 'view tab icon', SLOW)
    expect(JSON.stringify(tabViews(tabsOf()))).not.toMatch(/favicon|data:image|fav\.png/)
  })

  it('a background tab loads its own icon, and a <link> change event re-reads it', async () => {
    await open()
    const b = await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'agent' })
    rig.fake.emit(CDP_EVENT.frameStartedLoading, {}, 'S-T2')
    rig.fake.emit(CDP_EVENT.frameStoppedLoading, {}, 'S-T2')
    const iconOf = () => tabsOf().tabs.find((t) => t.tabId === b.tabId)?.faviconData
    await waitFor(() => !!iconOf(), 'background tab icon', SLOW)
    const reads = () => rig.fake.calls.filter((c) => c.method === CDP.evaluate && c.sessionId === 'S-T2').length
    const before = reads()
    rig.fake.emit(CDP_EVENT.bindingCalled, { name: FAVICON_BINDING, payload: '' }, 'S-T2')
    await waitFor(() => reads() > before, 'second read after the binding fired', SLOW)
  })

  it('switching tabs does not refetch (a view swap restates loading:false but no load ended)', async () => {
    await open()
    loadCycle('S-T1')
    await waitFor(() => !!tabsOf().tabs[0].faviconData, 'view tab icon', SLOW)
    const a = tabsOf().tabs[0].tabId
    await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'human' })
    await rig.host.tabApi.activate('n1', a, 'human')
    await new Promise((r) => setTimeout(r, 800))
    expect(rig.fake.calls.filter((c) => c.method === CDP.loadNetworkResource)).toHaveLength(1)
  })
})
