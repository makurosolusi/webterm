// Bun-only, REAL headless Chromium: popups become tabs of the opener's node and keep working as popups (window.opener,
// OAuth postMessage), the stream survives view switches, background tabs are discarded and woken. Registered only when a
// Chromium binary exists (same rule as browser.profiles.real.bun.test.ts), so CI without one stays green.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { MAX_TABS_PER_NODE } from '../../shared/browser.tabs'
import { detectChromium } from './chromium.launch'
import { POPUP_BURST_MAX, POPUP_BURST_WINDOW_MS } from './browserHost.shield'
import { bootRig, DIR_PREFIX, evalIn, openNode, sleep, tabsOf, TOKEN, until } from './browserHost.tabs.real.testkit'
import type { Rig } from './browserHost.tabs.real.testkit'

const found = detectChromium(process.env)
const TEST_TIMEOUT_MS = 120_000
const DISCARD_MS = 1_500
const FRAME_WINDOW_MS = 1_500
const rigs: Rig[] = []
afterAll(async () => { for (const r of rigs.splice(0)) await r.stop() })

const click = (r: Rig, node: string, tab: string, id: string) => evalIn<unknown>(r, node, tab, `document.getElementById('${id}').click()`, true)
const ids = (r: Rig, node: string) => tabsOf(r, node).tabs.map((t) => t.tabId)
const noticesOf = (r: Rig) => r.events.filter((e) => e.k === 'tabNotice').map((e) => (e as { message: string }).message)
/** The one tab that is not in `before`, once it exists. */
const newTabSince = (r: Rig, node: string, before: string[]) => until('a new tab', () => ids(r, node).find((i) => !before.includes(i)))
const hasProcess = (marker: string): boolean => spawnSync('pgrep', ['-f', marker]).status === 0

describe('real Chromium: popups as tabs', () => {
  if (found === null) return
  let main: Rig
  let late: Rig
  test('boot', async () => {
    main = await bootRig(found.path, 600_000)
    late = await bootRig(found.path, DISCARD_MS)
    rigs.push(main, late)
  }, TEST_TIMEOUT_MS)

  test('(a) window.open from a click = a new TAB of the same node, and its window.opener is alive', async () => {
    const m = await openNode(main, 'na', '/main')
    await click(main, 'na', m, 's')
    const p = await newTabSince(main, 'na', [m])
    expect(ids(main, 'na')).toEqual([m, p])
    await until('popup loaded', async () => (await evalIn<string>(main, 'na', p, 'document.title')).startsWith('opener:') || undefined)
    expect(await evalIn(main, 'na', p, 'document.title')).toBe('opener:true')
    expect(await evalIn(main, 'na', p, 'window.opener !== null && !window.opener.closed')).toBe(true)
    expect(tabsOf(main, 'na').tabs.find((t) => t.tabId === p)?.openerTabId).toBe(m)
    expect(tabsOf(main, 'na').activeTabId).toBe(p) // a popup of the human's visible tab becomes the view, like Chrome
    expect(main.host.state('na')?.live).toBe('live')
  }, TEST_TIMEOUT_MS)

  test('(b) OAuth: popup postMessages the opener and closes itself; the tab goes, the opener is the view again', async () => {
    const m = await openNode(main, 'nb', '/main')
    await click(main, 'nb', m, 'o')
    await until('opener got the token', async () => (await evalIn<string>(main, 'nb', m, 'document.title')) === `GOT:${TOKEN}` || undefined)
    await until('popup tab gone', () => ids(main, 'nb').length === 1 || undefined)
    expect(tabsOf(main, 'nb').activeTabId).toBe(m)
    expect(main.host.state('nb')?.live).toBe('live') // the page closing itself is not a crash of the node
    expect(await evalIn(main, 'nb', m, 'document.title')).toBe(`GOT:${TOKEN}`)
    expect(noticesOf(main).filter((n) => n.includes('popup'))).toEqual([]) // a popup that finished its job is not an error to the user
  }, TEST_TIMEOUT_MS)

  test('(b2) OAuth with a popup that lives long enough to be adopted: it is the view, then closes itself', async () => {
    const m = await openNode(main, 'nb2', '/main')
    await click(main, 'nb2', m, 'w')
    const p = await newTabSince(main, 'nb2', [m])
    expect(tabsOf(main, 'nb2').activeTabId).toBe(p)
    await until('opener got the token', async () => (await evalIn<string>(main, 'nb2', m, 'document.title')) === `GOT:${TOKEN}` || undefined)
    await until('popup tab gone', () => ids(main, 'nb2').length === 1 || undefined)
    await until('opener is the view again', () => tabsOf(main, 'nb2').activeTabId === m || undefined)
    expect(main.host.state('nb2')?.live).toBe('live') // the page closing itself is not a crash of the node
    expect(tabsOf(main, 'nb2').closed.length).toBe(0) // a page that closed itself is not "recently closed"
    expect(main.events.some((e) => e.k === 'error' && e.nodeId === 'nb2')).toBe(false)
  }, TEST_TIMEOUT_MS)

  test('(c) target=_blank link = a new tab', async () => {
    const m = await openNode(main, 'nc', '/blank-target')
    await click(main, 'nc', m, 'l')
    const p = await newTabSince(main, 'nc', [m])
    await until('B loaded', async () => (await evalIn<string>(main, 'nc', p, 'document.title')) === 'B' || undefined)
    expect(tabsOf(main, 'nc').tabs.find((t) => t.tabId === p)?.url).toMatch(/\/b$/)
  }, TEST_TIMEOUT_MS)

  test('(d) the 9th popup is refused: no tab, a notice, and the link opens in the opener tab', async () => {
    const m = await openNode(main, 'nd', '/main')
    for (let i = 0; i < MAX_TABS_PER_NODE - 1; i++) {
      main.skew.ms += POPUP_BURST_WINDOW_MS + 1 // each popup in its own burst window; the burst cap has its own test
      const before = ids(main, 'nd')
      await click(main, 'nd', m, 's')
      await newTabSince(main, 'nd', before)
    }
    expect(ids(main, 'nd').length).toBe(MAX_TABS_PER_NODE)
    main.skew.ms += POPUP_BURST_WINDOW_MS + 1
    await click(main, 'nd', m, 's')
    await until('notice', () => noticesOf(main).some((n) => n.includes('opened in the tab that opened it')) || undefined)
    await until('opener tab navigated', async () => (await evalIn<string>(main, 'nd', m, 'location.pathname')) === '/stay' || undefined)
    expect(ids(main, 'nd').length).toBe(MAX_TABS_PER_NODE)
  }, TEST_TIMEOUT_MS)

  test('(e) a flood: more than POPUP_BURST_MAX quick popups are refused', async () => {
    const m = await openNode(main, 'ne', '/main')
    for (let i = 0; i < POPUP_BURST_MAX + 3; i++) await click(main, 'ne', m, 's')
    await until('popups settled', () => ids(main, 'ne').length === 1 + POPUP_BURST_MAX || undefined)
    await sleep(1_000) // refused popups are closed asynchronously; the count must not creep up
    expect(ids(main, 'ne').length).toBe(1 + POPUP_BURST_MAX)
    expect(main.host.state('ne')?.blockedPopups).toBe(3)
  }, TEST_TIMEOUT_MS)

  test('(f) screencast keeps flowing after the view moves to a popup and back', async () => {
    const m = await openNode(main, 'nf', '/main')
    let frames = 0
    await main.host.startScreencast('nf', (f) => { frames++; main.host.ackFrame('nf', f.seq) })
    const burst = async (what: string) => {
      const from = frames
      await until(`frames ${what}`, () => frames - from >= 3 || undefined, FRAME_WINDOW_MS * 4)
      return frames - from
    }
    expect(await burst('before')).toBeGreaterThan(2)
    await click(main, 'nf', m, 's')
    const p = await newTabSince(main, 'nf', [m])
    await until('view on popup', () => tabsOf(main, 'nf').activeTabId === p || undefined)
    expect(await burst('on the popup')).toBeGreaterThan(2)
    await main.host.tabApi.activate('nf', m, 'human')
    expect(tabsOf(main, 'nf').activeTabId).toBe(m)
    expect(await burst('back on the opener')).toBeGreaterThan(2)
    await main.host.stopScreencast('nf')
  }, TEST_TIMEOUT_MS)

  test('(g) a background tab is discarded after the delay and reloads its URL when activated', async () => {
    const m = await openNode(late, 'ng', '/main')
    const tab = await late.host.tabApi.newTab('ng', { url: `${late.origin}/b`, by: 'human' })
    await until('tab list', () => tabsOf(late, 'ng').activeTabId === tab.tabId || undefined)
    await until('opener tab discarded', () => tabsOf(late, 'ng').tabs.find((t) => t.tabId === m)?.discarded || undefined, DISCARD_MS * 6)
    expect(tabsOf(late, 'ng').tabs.find((t) => t.tabId === m)?.url).toBe(`${late.origin}/main`)
    await late.host.tabApi.activate('ng', m, 'human')
    await until('main reloaded', async () => (await evalIn<string>(late, 'ng', m, 'location.href')) === `${late.origin}/main` || undefined)
    expect(tabsOf(late, 'ng').tabs.find((t) => t.tabId === m)?.discarded).toBe(false)
    expect(await evalIn(late, 'ng', m, 'document.title')).toBe('main')
  }, TEST_TIMEOUT_MS)

  test('(g2) an opener with a live popup is not discarded while the popup lives: window.opener survives the discard delay', async () => {
    const m = await openNode(late, 'ng2', '/main')
    await click(late, 'ng2', m, 's')
    const p = await newTabSince(late, 'ng2', [m])
    await until('popup loaded', async () => (await evalIn<string>(late, 'ng2', p, 'document.title')).startsWith('opener:') || undefined)
    await sleep(DISCARD_MS * 3)
    expect(tabsOf(late, 'ng2').tabs.find((t) => t.tabId === m)?.discarded).toBe(false)
    expect(await evalIn(late, 'ng2', p, 'window.opener !== null && !window.opener.closed')).toBe(true)
  }, TEST_TIMEOUT_MS)

  test('(h) shutdown leaves no Chromium process and no temp data dir', async () => {
    const dirs = rigs.map((r) => r.dir)
    for (const r of rigs.splice(0)) await r.stop()
    await until('chromium gone', () => !dirs.some(hasProcess) || undefined, 15_000)
    expect(dirs.some(hasProcess)).toBe(false)
    expect(DIR_PREFIX.length > 0 && dirs.every((d) => spawnSync('test', ['-e', d]).status !== 0)).toBe(true)
  }, TEST_TIMEOUT_MS)
})
