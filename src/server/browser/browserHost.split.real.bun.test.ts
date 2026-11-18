// Bun-only, REAL headless Chromium: two tabs on screen at once stream together with the right tab on every frame, each tab
// has its own device (the page's own `innerWidth` proves it), input lands in the pane it was made in, and nothing is left
// running afterwards. Registered only when a Chromium binary exists, so CI without one stays green.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Frame } from '../../shared/browser.contract'
import { splitPane } from '../../shared/browser.layout'
import { detectChromium } from './chromium.launch'
import { bootRig, DIR_PREFIX, evalIn, openNode, tabsOf, until } from './browserHost.tabs.real.testkit'
import type { Rig } from './browserHost.tabs.real.testkit'

const found = detectChromium(process.env)
const TEST_TIMEOUT_MS = 120_000
const FRAMES_WANTED = 3
const NODE = 'ns'
let rig: Rig | undefined
afterAll(async () => { await rig?.stop() })

const hasProcess = (marker: string): boolean => spawnSync('pgrep', ['-f', marker]).status === 0
const click = (r: Rig, tab: string) => (['down', 'up'] as const).reduce(
  (p, type) => p.then(() => r.host.input(NODE, { t: 'mouse', type, x: 50, y: 50, button: 'left', buttons: type === 'down' ? 1 : 0, clickCount: 1, mods: 0, dx: 0, dy: 0, tab })), Promise.resolve())

describe('real Chromium: split view', () => {
  if (found === null) return
  let a = ''
  let b = ''
  const frames = new Map<string, number>()

  test('boot: two tabs, both on screen, streaming', async () => {
    rig = await bootRig(found.path, 600_000)
    a = await openNode(rig, NODE, '/b')
    b = (await rig.host.tabApi.newTab(NODE, { url: `${rig.origin}/click`, by: 'human' })).tabId
    await until('second tab loaded', async () => (await evalIn<boolean>(rig as Rig, NODE, b, '!!document.getElementById("k")')) || undefined)
    const r = rig
    await r.host.startScreencast(NODE, (f: Frame) => { frames.set(f.tabId ?? '', (frames.get(f.tabId ?? '') ?? 0) + 1); r.host.ackFrame(NODE, f.seq) })
    await r.host.tabApi.setLayout(NODE, splitPane(null, a, b, 'right'), a)
    expect(tabsOf(r, NODE).activeTabId).toBe(a)
  }, TEST_TIMEOUT_MS)

  test('frames flow for BOTH tabs, each tagged with its own tab id', async () => {
    await until('frames of both panes', () => ((frames.get(a) ?? 0) >= FRAMES_WANTED && (frames.get(b) ?? 0) >= FRAMES_WANTED) || undefined, 20_000)
    expect([...frames.keys()].sort()).toEqual([a, b].sort()) // nothing untagged once the node is split
  }, TEST_TIMEOUT_MS)

  test('device per tab: the pages report different widths', async () => {
    const r = rig as Rig
    await r.host.tabApi.setTabDevice(NODE, a, { id: 'custom', w: 390, h: 844, dpr: 1 })
    await r.host.tabApi.setTabDevice(NODE, b, { id: 'custom', w: 1280, h: 800, dpr: 1 })
    await until('tab a is 390 wide', async () => (await evalIn<number>(r, NODE, a, 'window.innerWidth')) === 390 || undefined)
    expect(await evalIn<number>(r, NODE, b, 'window.innerWidth')).toBe(1280)
    expect(await evalIn<number>(r, NODE, a, 'window.innerHeight')).toBe(844)
    const before = { a: frames.get(a) ?? 0, b: frames.get(b) ?? 0 }
    await until('frames after the change', () => ((frames.get(a) ?? 0) > before.a && (frames.get(b) ?? 0) > before.b) || undefined, 20_000)
  }, TEST_TIMEOUT_MS)

  test('input to the second tab does not touch the first', async () => {
    const r = rig as Rig
    expect(await evalIn<string>(r, NODE, b, 'document.title')).toBe('idle')
    await click(r, b) // a is the focused pane; the click was made in b's pane
    await until('b clicked', async () => (await evalIn<string>(r, NODE, b, 'document.title')) === 'clicked' || undefined)
    expect(await evalIn<string>(r, NODE, a, 'document.title')).toBe('B')
    expect(tabsOf(r, NODE).activeTabId).toBe(a)
  }, TEST_TIMEOUT_MS)

  test('a pane that leaves the screen stops streaming', async () => {
    const r = rig as Rig
    await r.host.tabApi.setView(NODE, [a], a)
    await new Promise((res) => setTimeout(res, 600)) // frames already in flight
    const settled = frames.get(b) ?? 0
    await new Promise((res) => setTimeout(res, 1_200))
    expect(frames.get(b) ?? 0).toBe(settled)
    await r.host.stopScreencast(NODE)
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
