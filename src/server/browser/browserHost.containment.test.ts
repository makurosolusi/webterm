import { afterEach, describe, expect, it } from 'vitest'
import type { HostEvent } from './browserHost.service'
import { BLOCKED_OUTSIDE_NOTICE } from './browserHost.containment'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })
const callsOf = (m: string) => rig.fake.calls.filter((c) => c.method === m)
const notices = (ev: HostEvent[]) => ev.filter((e) => e.k === 'tabNotice').map((e) => (e as { message: string }).message)

/** Window of each target; unknown ids answer "no target" like Chromium. T1 = the node's page. */
function windows(map: Record<string, number>) {
  rig.fake.handle('Browser.getWindowForTarget', (p) => {
    const id = map[String(p.targetId)]
    return id === undefined ? { __error: { code: -32000, message: 'No target with given id found' } } : { windowId: id }
  })
}
async function open() {
  rig = await makeHostRig(stubGuard(), { containGraceMs: 20 })
  const events: HostEvent[] = []
  rig.host.onEvent((e) => events.push(e))
  await rig.host.open('n1', 'w1', 'https://a.test/')
  return events
}
// Context-menu "Open link in new tab": a page target with NO openerId.
const strayPage = (id: string, url = 'https://link.test/') => rig.fake.emit(CDP_EVENT.targetCreated, { targetInfo: { targetId: id, type: 'page', title: '', url } })
const tabUrls = () => rig.host.tabsState('n1')!.tabs.map((t) => t.url)

describe('containment of pages Chromium opens by itself', () => {
  it('a no-opener page in the node window becomes a tab of that node and the stray page is closed', async () => {
    await open()
    windows({ T1: 7, X1: 7 })
    strayPage('X1')
    await waitFor(() => tabUrls().length === 2, 'rescued tab')
    expect(tabUrls()).toContain('https://link.test/')
    expect(callsOf(CDP.closeTarget).map((c) => c.params.targetId)).toContain('X1')
  })

  it('a page in an unknown window with no recent gesture is closed with a visible notice and no tab', async () => {
    const ev = await open()
    windows({ T1: 7, X1: 99 })
    strayPage('X1')
    await waitFor(() => notices(ev).includes(BLOCKED_OUTSIDE_NOTICE), 'notice')
    expect(callsOf(CDP.closeTarget).map((c) => c.params.targetId)).toContain('X1')
    expect(tabUrls()).toEqual(['https://a.test/'])
  })

  it('a page in a new window right after a right click lands in the node that was clicked', async () => {
    await open()
    windows({ T1: 7, X1: 99 })
    await rig.host.input('n1', { t: 'mouse', type: 'down', x: 5, y: 5, button: 'right', buttons: 2, clickCount: 1, mods: 0, dx: 0, dy: 0 })
    strayPage('X1')
    await waitFor(() => tabUrls().length === 2, 'rescued tab')
  })

  it('pages the host created itself are never treated as strays', async () => {
    await open()
    windows({ T1: 7 })
    await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'human' })
    await new Promise((r) => setTimeout(r, 120))
    expect(callsOf(CDP.closeTarget)).toHaveLength(0)
    expect(tabUrls()).toHaveLength(2)
  })
})
