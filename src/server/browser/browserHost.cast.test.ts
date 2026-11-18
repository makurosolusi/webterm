import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpCommandError } from './cdp.client'
import { startCast, stopCast, isAlreadyActive } from './browserHost.cast'
import { tabsRoute } from '../browserApi.tabs'
import { makeHostRig, stubGuard, strictScreencast } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })
const tabs = () => rig.host.tabsState('n1')!
const sid = (tabId: string) => `S-T${tabs().tabs.findIndex((t) => t.tabId === tabId) + 1}`
const starts = (s?: string) => rig.fake.calls.filter((c) => c.method === 'Page.startScreencast' && (!s || c.sessionId === s))

/** Strict-Chromium rig: tabs a (T1), b (T2), the human on b, a viewer streaming. */
async function open() {
  rig = await makeHostRig(stubGuard())
  const active = strictScreencast(rig.fake)
  await rig.host.open('n1', 'w1', 'https://a.test/')
  await rig.host.tabApi.newTab('n1', { url: 'https://b.test/', by: 'human' })
  await rig.host.startScreencast('n1', () => undefined)
  const [a, b] = tabs().tabs.map((t) => t.tabId)
  return { a, b, active }
}

const cdpErr = (m: string) => new CdpCommandError(`cdp x failed: ${m}`, 'Page.startScreencast', -32000, m)

describe('cast helpers', () => {
  it('already active -> restart (stop + start); not active on stop -> success; other errors propagate', async () => {
    const calls: string[] = []
    let first = true
    await startCast(async (m) => { calls.push(m); if (first) { first = false; throw cdpErr('Screencast is already active') } }, {}, 't')
    expect(calls).toEqual(['Page.startScreencast', 'Page.stopScreencast', 'Page.startScreencast'])
    await stopCast(async () => { throw cdpErr('Screencast is not active') }, 't')
    await expect(startCast(async () => { throw cdpErr('Internal error') }, {}, 't')).rejects.toThrow('Internal error')
    expect(isAlreadyActive(new Error('Screencast is already active'))).toBe(false)
  })
})

describe('screencast is idempotent and serial', () => {
  it('ten quick alternating activations: no CDP error, exactly the active tab streams', async () => {
    const { a, b, active } = await open()
    const errs = vi.spyOn(console, 'error')
    for (let i = 0; i < 10; i++) await Promise.all([rig.host.tabApi.activate('n1', a, 'human'), rig.host.tabApi.activate('n1', b, 'human'), rig.host.tabApi.activate('n1', a, 'human')])
    expect([...active]).toEqual([sid(tabs().activeTabId as string)])
    expect(errs).not.toHaveBeenCalled()
  })

  it('a side-pane stream promoted to the view does not hit "already active"', async () => {
    const { a, b, active } = await open()
    await rig.host.tabApi.setView('n1', [a, b], b) // a streams as a side pane
    expect(active.has(sid(a))).toBe(true)
    await rig.host.tabApi.activate('n1', a, 'human') // a becomes the view
    await rig.host.tabApi.setView('n1', [a, b], a)
    expect(tabs().activeTabId).toBe(a)
    expect([...active].sort()).toEqual([sid(a), sid(b)])
  })

  it('the same view sent again and a viewer start racing an activation start nothing twice', async () => {
    const { a, b, active } = await open()
    await rig.host.tabApi.setView('n1', [a, b], b)
    const before = starts().length
    await rig.host.tabApi.setView('n1', [a, b], b)
    expect(starts().length).toBe(before)
    await Promise.all([rig.host.startScreencast('n1', () => undefined), rig.host.tabApi.activate('n1', a, 'human'), rig.host.stopScreencast('n1'), rig.host.startScreencast('n1', () => undefined)])
    expect(active.has(sid(tabs().activeTabId as string))).toBe(true)
  })

  it('stopping a node that streams nothing is a success', async () => {
    const { active } = await open()
    await rig.host.stopScreencast('n1')
    expect(active.size).toBe(0)
    await expect(rig.host.stopScreencast('n1')).resolves.toBeUndefined()
  })

  it('a discarded background tab woken by activation streams once', async () => {
    const { a, active } = await open()
    await rig.host.tabApi.activate('n1', a, 'human')
    await rig.host.tabApi.activate('n1', tabs().tabs[1].tabId, 'human')
    await rig.host.tabApi.activate('n1', a, 'human')
    expect([...active]).toEqual([sid(a)])
  })
})

describe('activate endpoint', () => {
  it('answers 200 when the activation repeats; a real CDP failure is a 502, not a 500', async () => {
    const { a } = await open()
    const deps = { activate: async (n: string, t: string) => { await rig.host.tabApi.activate(n, t, 'human'); return { state: tabs() } } } as never
    expect((await tabsRoute('POST', 'n1', [a, 'activate'], async () => '', deps))?.status).toBe(200)
    expect((await tabsRoute('POST', 'n1', [a, 'activate'], async () => '', deps))?.status).toBe(200)
    const boom = { activate: async () => { throw cdpErr('Internal error') } } as never
    expect((await tabsRoute('POST', 'n1', [a, 'activate'], async () => '', boom))?.status).toBe(502)
  })
})
