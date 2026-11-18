// Bun-only, REAL headless Chromium: two tabs side by side. Sync mode repeats a human click in the other pane by meaning (role +
// name), marks a pane that has no such element, mirrors navigation; and the agent verbs (`layout set`, `--all`) run one action
// on every tab and answer per tab. Registered only when a Chromium binary exists, so CI without one stays green.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { AllData } from '../../shared/browser.contract'
import { withLayout } from './browser.agentLayout.verbs'
import { agentTabHost, withNewTab } from './browser.agentTabs'
import { withTabs } from './browser.agentTabs.verbs'
import { SnapshotStore } from './browserAgent.snapshot'
import { createAgentVerbs } from './browserAgent.verbs'
import { LeaseService } from './browserLease.service'
import { detectChromium } from './chromium.launch'
import { bootRig, DIR_PREFIX, evalIn, openNode, tabsOf, until } from './browserHost.tabs.real.testkit'
import type { Rig } from './browserHost.tabs.real.testkit'

const found = detectChromium(process.env)
const TEST_TIMEOUT_MS = 120_000
const NODE = 'nq'
let rig: Rig | undefined
afterAll(async () => { await rig?.stop() })

const hasProcess = (marker: string): boolean => spawnSync('pgrep', ['-f', marker]).status === 0
const titleOf = (r: Rig, tab: string) => evalIn<string>(r, NODE, tab, 'document.title')
/** Centre of the first element with this id, in the page's own coordinates. */
const centre = (r: Rig, tab: string, id: string) => evalIn<{ x: number; y: number }>(r, NODE, tab, `(()=>{const b=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
async function humanClick(r: Rig, tab: string, id: string): Promise<void> {
  const { x, y } = await centre(r, tab, id)
  for (const type of ['down', 'up'] as const) await r.host.input(NODE, { t: 'mouse', type, x, y, button: 'left', buttons: type === 'down' ? 1 : 0, clickCount: 1, mods: 0, dx: 0, dy: 0 })
}

describe('real Chromium: sync mode and --all', () => {
  if (found === null) return
  let a = ''
  let b = ''

  test('boot: two tabs side by side, sync on', async () => {
    rig = await bootRig(found.path, 600_000)
    a = await openNode(rig, NODE, '/qc-a')
    b = (await rig.host.tabApi.newTab(NODE, { url: `${rig.origin}/qc-b`, by: 'human' })).tabId
    await until('second tab loaded', async () => (await evalIn<string>(rig as Rig, NODE, b, 'document.title')) === 'QB' || undefined)
    await rig.host.tabApi.setLayout(NODE, { dir: 'h', ratio: 0.5, a: { id: a }, b: { id: b } }, a)
    rig.host.sync.set(NODE, true)
    expect(rig.host.syncOn(NODE)).toBe(true)
  }, TEST_TIMEOUT_MS)

  test('a click on "Buy" in pane A is repeated on the "Buy" of pane B (found by role and name, not by place)', async () => {
    const r = rig as Rig
    await humanClick(r, a, 'buy')
    await until('both bought', async () => ((await titleOf(r, a)) === 'bought-a' && (await titleOf(r, b)) === 'bought-b') || undefined)
    expect(r.events.some((e) => e.k === 'syncMiss')).toBe(false)
  }, TEST_TIMEOUT_MS)

  test('a control that exists only in pane A: pane B is marked "no match", nothing breaks, A still works', async () => {
    const r = rig as Rig
    await humanClick(r, a, 'only')
    await until('A clicked', async () => (await titleOf(r, a)) === 'only-a' || undefined)
    await until('B marked', () => r.events.find((e) => e.k === 'syncMiss') || undefined)
    expect(r.events.find((e) => e.k === 'syncMiss')).toMatchObject({ tab: b, reason: 'no_match' })
    expect(await titleOf(r, b)).toBe('bought-b') // unchanged
  }, TEST_TIMEOUT_MS)

  test('navigation of the focused pane is repeated in the other pane', async () => {
    const r = rig as Rig
    await r.host.navAction(NODE, 'go', `${r.origin}/b`)
    await until('both on /b', async () => ((await evalIn<string>(r, NODE, a, 'location.pathname')) === '/b' && (await evalIn<string>(r, NODE, b, 'location.pathname')) === '/b') || undefined)
    await r.host.navAction(NODE, 'go', `${r.origin}/qc-a`)
    await until('both on /qc-a', async () => (await evalIn<string>(r, NODE, b, 'location.pathname')) === '/qc-a' || undefined)
    r.host.sync.set(NODE, false)
    expect(r.host.syncOn(NODE)).toBe(false)
  }, TEST_TIMEOUT_MS)

  test('agent verbs: layout set opens the tab and splits; --all answers per tab (headings, a semantic click, screenshots)', async () => {
    const r = rig as Rig
    const leases = new LeaseService()
    const deps = { host: r.host, leases, agentAllowed: () => true, sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)) }
    const verbs = withLayout(withTabs(withNewTab(createAgentVerbs({ host: agentTabHost(r.host), leases, snapshots: new SnapshotStore(), agentAllowed: () => true, sleep: deps.sleep, now: Date.now }), r.host), deps), deps)
    const set = await verbs.arrange(NODE, { spec: `h ${a} new:${r.origin}/qc-b` })
    expect(set.panes).toHaveLength(2)
    const c = tabsOf(r, NODE).tabs.find((t) => t.tabId !== a && t.tabId !== b)
    expect(c).toBeDefined() // the layout opened its own third tab for the new page
    const id = c?.tabId as string
    await until('new tab loaded', async () => (await evalIn<string>(r, NODE, id, 'document.title')) === 'QB' || undefined)

    const snaps = (await verbs.snapshot(NODE, { all: true })) as unknown as AllData
    expect(snaps.okCount).toBe(2)
    expect(snaps.results.map((x) => String(x.content))).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta')])

    const click = (await verbs.click(NODE, { all: true, name: 'buy', role: 'button' })) as unknown as AllData
    expect(click.okCount).toBe(2)
    await until('both bought by the agent', async () => ((await titleOf(r, a)) === 'bought-a' && (await titleOf(r, id)) === 'bought-b') || undefined)

    const miss = (await verbs.click(NODE, { all: true, name: 'OnlyA' })) as unknown as AllData
    expect(miss.results.map((x) => [x.ok, x.error])).toEqual([[true, undefined], [false, 'no_match']])

    const shots = (await verbs.screenshot(NODE, { layout: true })) as unknown as AllData
    expect(shots.results.map((x) => [x.ok, x.mime])).toEqual([[true, 'image/jpeg'], [true, 'image/jpeg']])
    expect(String(shots.results[0].base64).length).toBeGreaterThan(200)

    const nav = (await verbs.navigate(NODE, { all: true, url: `${r.origin}/b` })) as unknown as AllData
    expect(nav.okCount).toBe(2)
    await until('both tabs on /b', async () => ((await evalIn<string>(r, NODE, a, 'location.pathname')) === '/b' && (await evalIn<string>(r, NODE, id, 'location.pathname')) === '/b') || undefined)
  }, TEST_TIMEOUT_MS)

  test('shutdown leaves no Chromium process and no temp data dir', async () => {
    const r = rig as Rig
    const dir = r.dir
    await r.stop()
    rig = undefined
    await until('chromium gone', () => !hasProcess(dir) || undefined, 15_000)
    expect(hasProcess(dir)).toBe(false)
    expect(DIR_PREFIX.length > 0 && spawnSync('test', ['-e', dir]).status !== 0).toBe(true)
  }, TEST_TIMEOUT_MS)
})
