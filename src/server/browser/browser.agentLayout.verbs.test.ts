import { afterEach, describe, expect, it } from 'vitest'
import { MAX_TABS_PER_NODE } from '../../shared/browser.tabs'
import type { AllData } from '../../shared/browser.contract'
import { BlockedError } from '../../shared/browser.contract'
import { ALL_SHOT_WIDTH, withLayout } from './browser.agentLayout.verbs'
import { withTabs } from './browser.agentTabs.verbs'
import { withNewTab } from './browser.agentTabs'
import type { BaseVerbs } from './browserAgent.verbs.ctx'
import { BrowserError } from './browserHost.targets'
import { wrapUntrusted } from './browserAgent.wrap'
import { CDP } from './cdp.client'
import { makeHostRig, stubGuard } from './fakeCdp.testkit'

type Rig = Awaited<ReturnType<typeof makeHostRig>>
let rig: Rig
afterEach(async () => { await rig?.stop() })

let snaps = 0
/** `tab` = the agent's working tab when the verb ran (withTabs strips `tab` from the body and moves the cursor instead). */
const seen: Array<{ verb: string; body: Record<string, unknown>; tab?: string }> = []
const PAGE = ['status', 'snapshot', 'screenshot', 'wait', 'console', 'navigate', 'click', 'type', 'press', 'scroll', 'handoff', 'release'] as const
const base = (failOn?: { verb: string; tab: () => string | undefined }): BaseVerbs => Object.fromEntries(PAGE.map((verb) => [verb, async (_n: string, body: Record<string, unknown>) => {
  seen.push({ verb, body, tab: rig.host.tabApi.agentTab('n1') })
  if (failOn && failOn.verb === verb && rig.host.tabApi.agentTab('n1') === failOn.tab()) throw new BrowserError('crashed', 'page is gone')
  if (verb === 'snapshot') return { snapId: 's1', content: wrapUntrusted(`heading #${++snaps}`), truncated: false, url: 'https://x.test/' }
  if (verb === 'screenshot') return { mime: 'image/jpeg', base64: 'QUJD' }
  return { ok: true }
}])) as unknown as BaseVerbs
const lease = { acquire: async () => ({ lease: 'agent' as const, ttlMs: 1 }) }

async function open(failOn?: { verb: string; tab: () => string | undefined }) {
  seen.length = 0
  rig = await makeHostRig(stubGuard(['evil.test']), { agentDriving: () => true })
  await rig.host.open('n1', 'w1', 'https://a.test/')
  return withLayout(withTabs(withNewTab(base(failOn), rig.host), { host: rig.host, leases: lease, agentAllowed: () => true, sleep: async () => undefined }), { host: rig.host, leases: lease, agentAllowed: () => true, sleep: async () => undefined })
}
const tabIds = () => rig.host.tabsState('n1')!.tabs.map((t) => t.tabId)
const callsOf = (m: string, sid: string) => rig.fake.calls.filter((c) => c.method === m && c.sessionId === sid)
const all = (r: unknown) => r as AllData

describe('layout / arrange', () => {
  it('describes a node without a split as one pane', async () => {
    const v = await open()
    const r = await v.layout('n1', {})
    expect(r).toMatchObject({ split: false, sync: false, maxPanes: 4, tree: tabIds()[0] })
    expect(r.panes).toHaveLength(1)
    expect(r.panes[0]).toMatchObject({ tab: tabIds()[0], host: 'a.test', focus: true })
  })

  it('builds columns from an existing tab and a new one, and reads the tree back', async () => {
    const v = await open()
    const [a] = tabIds()
    const r = await v.arrange('n1', { spec: `h ${a} new:https://b.test/` })
    const [, b] = tabIds()
    expect(r.tree).toBe(`h(${a}, ${b})`)
    expect(r.split).toBe(true)
    expect(r.panes.map((p) => p.host)).toEqual(['a.test', 'b.test'])
    expect(r.note).toContain('--all')
    expect((await v.layout('n1', {})).tree).toBe(r.tree)
  })

  it('single drops the split, grid needs four, and a spec with a bad tab or shape is refused with the fix', async () => {
    const v = await open()
    const [a] = tabIds()
    await v.arrange('n1', { spec: `v ${a} new:https://b.test/` })
    expect((await v.arrange('n1', { spec: `single ${a}` })).split).toBe(false)
    await expect(v.arrange('n1', { spec: `grid ${a} new:https://b.test/` })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('exactly 4') })
    await expect(v.arrange('n1', { spec: 'h t99 t98' })).rejects.toMatchObject({ wire: 'unknown_tab', status: 404 })
    await expect(v.arrange('n1', { spec: 'zig a b' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(v.arrange('n1', {})).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('refuses a layout that would pass the tab limit before opening any tab', async () => {
    const v = await open()
    for (let i = 1; i < MAX_TABS_PER_NODE - 1; i++) await v.tab('n1', { action: 'new', url: `https://t${i}.test/` })
    const before = tabIds().length
    await expect(v.arrange('n1', { spec: 'h new:https://x.test/ new:https://y.test/' })).rejects.toMatchObject({ wire: 'tab_limit', status: 409 })
    expect(tabIds()).toHaveLength(before)
  })

  it('opens new tabs through the SSRF guard', async () => {
    const v = await open()
    const [a] = tabIds()
    await expect(v.arrange('n1', { spec: `h ${a} new:http://evil.test/` })).rejects.toBeInstanceOf(BlockedError)
  })

  it('caps the layout at four panes', async () => {
    const v = await open()
    const [a] = tabIds()
    const r = await v.arrange('n1', { spec: `grid ${a} new:https://b.test/ new:https://c.test/ new:https://d.test/` })
    expect(r.panes).toHaveLength(4)
    expect(r.tree).toMatch(/^v\(h\(.+, .+\), h\(.+, .+\)\)$/)
    await expect(v.arrange('n1', { spec: `h ${a} t2 t3 t4 t5` })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('at most 4') })
  })
})

describe('sync verb', () => {
  it('needs a split, then switches and reports', async () => {
    const v = await open()
    await expect(v.sync('n1', { on: true })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('split') })
    await v.arrange('n1', { spec: `h ${tabIds()[0]} new:https://b.test/` })
    expect(await v.sync('n1', { on: true })).toMatchObject({ on: true, note: expect.stringContaining('--all') })
    expect(rig.host.syncOn('n1')).toBe(true)
    expect((await v.layout('n1', {})).sync).toBe(true)
    expect(await v.sync('n1', { on: false })).toMatchObject({ on: false })
    await expect(v.sync('n1', { on: 'yes' })).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('--all', () => {
  async function two() {
    const v = await open()
    const [a] = tabIds()
    await v.arrange('n1', { spec: `h ${a} new:https://b.test/` })
    seen.length = 0
    return { v, a, b: tabIds()[1] }
  }

  it('runs the verb on every tab of the layout and answers per tab', async () => {
    const { v, a, b } = await two()
    const r = all(await v.navigate('n1', { all: true, url: 'https://c.test/' }))
    expect(r).toMatchObject({ all: true, okCount: 2, failedCount: 0 })
    expect(r.results.map((x) => [x.tab, x.ok])).toEqual([[a, true], [b, true]])
    expect(seen.filter((s) => s.verb === 'navigate').map((s) => s.tab)).toEqual([a, b])
    expect(seen.every((s) => s.body.all === undefined)).toBe(true)
  })

  it('one tab failing does not fail the others, and the working tab is put back', async () => {
    const v = await open({ verb: 'navigate', tab: () => tabIds()[1] })
    const [a] = tabIds()
    await v.arrange('n1', { spec: `h ${a} new:https://b.test/` })
    const b = tabIds()[1]
    await rig.host.tabApi.activate('n1', a, 'agent')
    const r = all(await v.navigate('n1', { all: true, url: 'https://c.test/' }))
    expect(r).toMatchObject({ okCount: 1, failedCount: 1 })
    expect(r.results.find((x) => x.tab === b)).toMatchObject({ ok: false, error: 'crashed', message: 'page is gone' })
    expect(r.results.find((x) => x.tab === a)).toMatchObject({ ok: true })
    expect(rig.host.tabApi.agentTab('n1')).toBe(a)
  })

  it('snapshot --all returns each tab\'s content (never a usable snapId); screenshot --layout is a named list at a small default width', async () => {
    const { v, a, b } = await two()
    const snap = all(await v.snapshot('n1', { all: true }))
    expect(snap.results.map((x) => x.tab)).toEqual([a, b])
    expect(snap.results[0]).toMatchObject({ ok: true, content: expect.stringContaining('heading #'), note: expect.stringContaining('refs are not usable') })
    expect(snap.results[0]).not.toHaveProperty('snapId')
    const shots = all(await v.screenshot('n1', { layout: true }))
    expect(shots.results.map((x) => [x.tab, x.name, x.mime, x.base64])).toEqual([[a, 'a.test', 'image/jpeg', 'QUJD'], [b, 'b.test', 'image/jpeg', 'QUJD']])
    expect(seen.filter((s) => s.verb === 'screenshot').map((s) => s.body.maxWidth)).toEqual([ALL_SHOT_WIDTH, ALL_SHOT_WIDTH])
  })

  it('without a split it runs on the one visible tab and says so', async () => {
    const v = await open()
    const r = all(await v.snapshot('n1', { all: true }))
    expect(r.results).toHaveLength(1)
    expect(r.note).toContain('No split layout')
  })

  it('refuses --all together with --tab, a ref click, a click without a name, and a wrong flag value', async () => {
    const { v, a } = await two()
    await expect(v.navigate('n1', { all: true, tab: a, url: 'https://c.test/' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('not both') })
    await expect(v.click('n1', { all: true, ref: 'e1', snapId: 's1', name: 'Buy' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('by ref') })
    await expect(v.click('n1', { all: true })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(v.click('n1', { all: true, name: 'Buy', nth: 0 })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(v.snapshot('n1', { all: false })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('click --all finds the element by role and name in each tab; a tab without it is a no_match result, not a failure of the run', async () => {
    const { v, a, b } = await two()
    const tree = (name: string, id: number) => ({ nodes: [{ nodeId: 'r', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['n'] }, { nodeId: 'n', role: { value: 'button' }, name: { value: name }, backendDOMNodeId: id }] })
    rig.fake.handle('Accessibility.getFullAXTree', (_p, sid) => (sid === 'S-T1' ? tree('Buy now', 10) : tree('Docs', 20)))
    rig.fake.handle('DOM.getContentQuads', () => ({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }))
    rig.fake.handle('DOM.describeNode', () => ({ node: { attributes: [] } }))
    const r = all(await v.click('n1', { all: true, name: 'buy', role: 'button' }))
    expect(r.results.find((x) => x.tab === a)).toMatchObject({ ok: true, matched: true })
    expect(r.results.find((x) => x.tab === b)).toMatchObject({ ok: false, error: 'no_match' })
    expect(r).toMatchObject({ okCount: 1, failedCount: 1 })
    expect(callsOf(CDP.mouse, 'S-T1')).toHaveLength(3)
    expect(callsOf(CDP.mouse, 'S-T2')).toHaveLength(0)
  })

  it('type --all focuses the named field in every tab and types there', async () => {
    const { v } = await two()
    const tree = { nodes: [{ nodeId: 'r', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['n'] }, { nodeId: 'n', role: { value: 'textbox' }, name: { value: 'Search' }, backendDOMNodeId: 9 }] }
    rig.fake.handle('Accessibility.getFullAXTree', () => tree)
    const r = all(await v.type('n1', { all: true, name: 'Search', text: 'shoes', submit: true }))
    expect(r.okCount).toBe(2)
    expect(callsOf(CDP.insertText, 'S-T1')[0].params.text).toBe('shoes')
    expect(callsOf(CDP.insertText, 'S-T2')[0].params.text).toBe('shoes')
    expect(callsOf('DOM.focus', 'S-T2')).toHaveLength(1)
  })

  it('reload --all reloads each tab on its own page', async () => {
    const { v } = await two()
    rig.fake.calls.length = 0
    const r = all(await v.reload('n1', { all: true }))
    expect(r.okCount).toBe(2)
    expect(callsOf(CDP.reload, 'S-T1')).toHaveLength(1)
    expect(callsOf(CDP.reload, 'S-T2')).toHaveLength(1)
  })
})

describe('reload / back / forward on one tab', () => {
  it('acts on --tab (which becomes the working tab) or on the working tab', async () => {
    const v = await open()
    const [a] = tabIds()
    await v.arrange('n1', { spec: `h ${a} new:https://b.test/` })
    const b = tabIds()[1]
    rig.fake.handle(CDP.getNavigationHistory, () => ({ currentIndex: 1, entries: [{ id: 5 }, { id: 6 }, { id: 7 }] }))
    rig.fake.calls.length = 0
    expect(await v.back('n1', { tab: b })).toEqual({ ok: true })
    expect(rig.host.tabApi.agentTab('n1')).toBe(b)
    expect(callsOf(CDP.navigateToHistoryEntry, 'S-T2')[0].params.entryId).toBe(5)
    await v.forward('n1', {})
    expect(callsOf(CDP.navigateToHistoryEntry, 'S-T2')[1].params.entryId).toBe(7)
    await v.reload('n1', {})
    expect(callsOf(CDP.reload, 'S-T2')).toHaveLength(1)
  })

  it('says so when there is nowhere to go back to, and when the tab is unknown', async () => {
    const v = await open()
    rig.fake.handle(CDP.getNavigationHistory, () => ({ currentIndex: 0, entries: [{ id: 5 }] }))
    await expect(v.back('n1', {})).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('no page to go back to') })
    await expect(v.reload('n1', { tab: 'nope' })).rejects.toMatchObject({ wire: 'unknown_tab' })
  })
})
