import { afterEach, describe, expect, it } from 'vitest'
import type { HostEvent } from './browserHost.service'
import type { PersistedTabs } from '../../shared/browser.tabs'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })
const callsOf = (m: string) => rig.fake.calls.filter((c) => c.method === m)
const tabsOf = () => rig.host.tabsState('n1')!
const urls = () => tabsOf().tabs.map((t) => t.url)

async function open(extra: Parameters<typeof makeHostRig>[2] = {}, url = 'https://a.test/') {
  rig = await makeHostRig(stubGuard(['evil.test']), extra)
  const events: HostEvent[] = []
  rig.host.onEvent((e) => events.push(e))
  await rig.host.open('n1', 'w1', url)
  return events
}
const noticeOf = (ev: HostEvent[]) => ev.filter((e) => e.k === 'tabNotice').map((e) => (e as { message: string }).message)
const popup = (id: string, url: string, opener = 'T1') => rig.fake.emit(CDP_EVENT.targetCreated, { targetInfo: { targetId: id, type: 'page', title: '', url, openerId: opener } })
const add = (url: string, by: 'human' | 'agent' = 'human') => rig.host.tabApi.newTab('n1', { url, by })

describe('tab model', () => {
  it('a node without saved tabs is one tab at the current url; both cursors point at it', async () => {
    await open()
    expect(urls()).toEqual(['https://a.test/'])
    const s = tabsOf()
    expect(s.activeTabId).toBe(s.tabs[0].tabId)
    expect(s.agentTabId).toBe(s.tabs[0].tabId)
  })

  it('newTab loads the url in its own page, the human view follows, the agent cursor stays', async () => {
    const ev = await open()
    const first = tabsOf().tabs[0].tabId
    const t = await add('https://b.test/')
    expect(tabsOf().activeTabId).toBe(t.tabId)
    expect(tabsOf().agentTabId).toBe(first)
    expect(callsOf(CDP.createTarget)).toHaveLength(2)
    expect(callsOf(CDP.navigate).at(-1)?.params.url).toBe('https://b.test/')
    expect(ev.some((e) => e.k === 'tab' && e.event.type === 'tabCreated')).toBe(true)
  })

  it('refuses a url the navigation guard blocks', async () => {
    await open()
    await expect(add('https://evil.test/')).rejects.toMatchObject({ reason: 'private_host' })
    expect(tabsOf().tabs).toHaveLength(1)
  })

  it('closing the active tab activates the right neighbour, else the left', async () => {
    await open()
    const a = tabsOf().tabs[0].tabId
    const b = (await add('https://b.test/')).tabId
    const c = (await add('https://c.test/')).tabId
    await rig.host.tabApi.activate('n1', b, 'human')
    await rig.host.tabApi.closeTab('n1', b)
    expect(tabsOf().activeTabId).toBe(c)
    await rig.host.tabApi.closeTab('n1', c)
    expect(tabsOf().activeTabId).toBe(a)
    expect(tabsOf().closed.map((t) => t.url)).toEqual(['https://c.test/', 'https://b.test/'])
  })

  it('closing the last tab leaves the node alive with an empty list; a new tab reuses its page', async () => {
    await open()
    await rig.host.tabApi.closeTab('n1', tabsOf().tabs[0].tabId)
    expect(tabsOf().tabs).toEqual([])
    expect(rig.host.state('n1')?.live).toBe('live')
    await add('https://b.test/')
    expect(callsOf(CDP.createTarget)).toHaveLength(1)
    expect(urls()).toEqual(['https://b.test/'])
  })

  it('human and agent cursors move independently; once the human chose, agent tabs do not move the view', async () => {
    await open()
    const a = tabsOf().tabs[0].tabId
    const b = (await add('https://b.test/')).tabId
    await rig.host.tabApi.activate('n1', a, 'human')
    await rig.host.tabApi.activate('n1', b, 'agent')
    expect(tabsOf()).toMatchObject({ activeTabId: a, agentTabId: b })
    const c = (await add('https://c.test/', 'agent')).tabId
    expect(tabsOf()).toMatchObject({ activeTabId: a, agentTabId: c })
  })

  it('reorder, duplicate and reopenClosed follow the shared reducer rules', async () => {
    await open()
    const b = (await add('https://b.test/')).tabId
    await rig.host.tabApi.move('n1', b, 0)
    expect(urls()).toEqual(['https://b.test/', 'https://a.test/'])
    const d = await rig.host.tabApi.duplicate('n1', b)
    expect(d.url).toBe('https://b.test/')
    await rig.host.tabApi.closeTab('n1', d.tabId)
    const r = await rig.host.tabApi.reopen('n1')
    expect(r.url).toBe('https://b.test/')
    expect(tabsOf().closed).toHaveLength(0)
  })
})

describe('popups', () => {
  it('window.open becomes a tab after its opener; the human view follows a popup from the visible tab', async () => {
    await open()
    popup('P1', 'https://oauth.test/')
    await waitFor(() => tabsOf().tabs.length === 2, 'popup tab')
    expect(urls()).toEqual(['https://a.test/', 'https://oauth.test/'])
    expect(tabsOf().tabs[1].openerTabId).toBe(tabsOf().tabs[0].tabId)
    expect(tabsOf().activeTabId).toBe(tabsOf().tabs[1].tabId)
    expect(callsOf(CDP.closeTarget)).toHaveLength(0)
  })

  it('at the limit the popup is closed, the opener tab loads the url, and a notice says why', async () => {
    const ev = await open()
    for (let i = 0; i < 7; i++) await add(`https://t${i}.test/`)
    expect(tabsOf().tabs).toHaveLength(8)
    popup('P9', 'https://over.test/', 'T8')
    await waitFor(() => noticeOf(ev).length === 1, 'notice')
    expect(noticeOf(ev)[0]).toContain('Tab limit (8) reached')
    expect(tabsOf().tabs).toHaveLength(8)
    await waitFor(() => callsOf(CDP.closeTarget).some((c) => c.params.targetId === 'P9'), 'popup closed')
    await waitFor(() => callsOf(CDP.navigate).some((c) => c.params.url === 'https://over.test/'), 'opener loads url')
  })

  it('a popup to a blocked host is closed with a notice and no tab', async () => {
    const ev = await open()
    popup('P1', 'https://evil.test/')
    await waitFor(() => noticeOf(ev).length === 1, 'notice')
    expect(tabsOf().tabs).toHaveLength(1)
  })

  it('the tab limit is enforced for the api', async () => {
    await open()
    for (let i = 0; i < 7; i++) await add(`https://t${i}.test/`)
    await expect(rig.host.tabApi.newTab('n1', { by: 'human' })).rejects.toMatchObject({ name: 'TabLimitError' })
  })
})

describe('streaming and discard', () => {
  it('the screencast stops on the old page and starts on the newly active one', async () => {
    await open()
    await rig.host.startScreencast('n1', () => undefined)
    const a = tabsOf().tabs[0].tabId
    await add('https://b.test/')
    expect(callsOf(CDP.stopScreencast).at(-1)?.sessionId).toBe('S-T1')
    expect(callsOf(CDP.startScreencast).at(-1)?.sessionId).toBe('S-T2')
    await rig.host.tabApi.activate('n1', a, 'human')
    expect(callsOf(CDP.stopScreencast).at(-1)?.sessionId).toBe('S-T2')
    expect(callsOf(CDP.startScreencast).at(-1)?.sessionId).toBe('S-T1')
  })

  it('an idle background tab is discarded but stays listed; activating it rebuilds the page', async () => {
    await open({ tabDiscardMs: 20 })
    const a = tabsOf().tabs[0].tabId
    await add('https://b.test/')
    await waitFor(() => tabsOf().tabs.find((t) => t.tabId === a)?.discarded === true, 'discard')
    expect(callsOf(CDP.closeTarget).some((c) => c.params.targetId === 'T1')).toBe(true)
    expect(tabsOf().tabs).toHaveLength(2)
    await rig.host.tabApi.activate('n1', a, 'human')
    expect(tabsOf().tabs.find((t) => t.tabId === a)?.discarded).toBe(false)
    expect(callsOf(CDP.navigate).at(-1)?.params.url).toBe('https://a.test/')
  })

  it('a crashed background tab is marked crashed and the node stays live', async () => {
    await open()
    const a = tabsOf().tabs[0].tabId
    await add('https://b.test/')
    rig.fake.emit(CDP_EVENT.targetCrashed, { targetId: 'T1' })
    await waitFor(() => tabsOf().tabs.find((t) => t.tabId === a)?.crashed === true, 'crashed')
    expect(rig.host.state('n1')?.live).toBe('live')
  })
})

describe('persistence', () => {
  it('saves the list after a debounce and restores it: the active tab loads, the others are discarded', async () => {
    const saved: Array<PersistedTabs | null> = []
    await open({ persistTabs: (_id, t) => saved.push(t) })
    await add('https://b.test/')
    await waitFor(() => saved.length > 0, 'saved', 4000)
    const last = saved.at(-1)!
    expect(last.tabs.map((t) => t.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(last.activeTabId).toBe(tabsOf().activeTabId)
    await rig.stop()

    rig = await makeHostRig(stubGuard(), { initialTabs: () => last })
    await rig.host.open('n1', 'w1')
    expect(callsOf(CDP.navigate).map((c) => c.params.url)).toEqual(['https://b.test/'])
    expect(tabsOf().tabs.map((t) => t.discarded)).toEqual([true, false])
  })
})
