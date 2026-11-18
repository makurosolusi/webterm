// Downloads through the real host + CDP wiring against the loopback fake CDP server: Chromium is never started.
// The test plays Chromium's part (writes `<guid>` into the folder, sends the Browser.download* events).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CDP, CDP_EVENT } from './cdp.client'
import { makeHostRig, stubGuard, waitFor } from './fakeCdp.testkit'
import { createDownloadStore } from './browser.downloads.store'
import type { DownloadMode } from './browserHost.downloads'
import { DOWNLOAD_MAX_FILE_BYTES, DOWNLOAD_PROGRESS_MIN_INTERVAL_MS } from '../../shared/browser.downloads'
import type { DownloadItem } from '../../shared/browser.downloads'
import type { HostEvent } from './browserHost.targets'

const NODE = 'n1'
const PROFILE = 'p1'
let root: string
let clock: number
let mode: DownloadMode
let rig: Awaited<ReturnType<typeof makeHostRig>>
let events: HostEvent[]

const folder = () => join(root, 'downloads', PROFILE)
const items = (): DownloadItem[] => rig.host.downloads!.list(NODE)
const begin = (guid: string, suggestedFilename = 'report.pdf', url = 'https://files.example/a/report.pdf?token=SECRET') =>
  rig.fake.emit(CDP_EVENT.downloadWillBegin, { frameId: 'T1', guid, url, suggestedFilename })
const progress = (guid: string, receivedBytes: number, totalBytes: number, state = 'inProgress') =>
  rig.fake.emit(CDP_EVENT.downloadProgress, { guid, receivedBytes, totalBytes, state })
const stateOf = (guid: string) => items().find((i) => i.id === guid)?.state

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wt-dl-'))
  clock = 1_000_000
  mode = 'save'
  const store = createDownloadStore({ root, now: () => clock, quota: 1000 })
  rig = await makeHostRig(stubGuard(), { downloads: { store, mode: () => mode }, now: () => clock })
  events = []
  rig.host.onEvent((e) => events.push(e))
  await rig.host.open(NODE, PROFILE)
})
afterEach(async () => {
  await rig.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('connection setup', () => {
  it('saves into the profile folder under the guid and asks for events (no longer denies)', () => {
    const call = rig.fake.calls.find((c) => c.method === CDP.setDownloadBehavior)
    expect(call?.params).toEqual({ behavior: 'allowAndName', downloadPath: folder(), eventsEnabled: true })
    expect(statSync(folder()).mode & 0o777).toBe(0o700)
  })
})

describe('a download from begin to done', () => {
  it('maps to the node and tab, hides the query, renames the file safely and keeps it private', async () => {
    begin('g1', '../../etc/passwd.pdf')
    await waitFor(() => items().length === 1, 'begin')
    expect(items()[0]).toMatchObject({ id: 'g1', nodeId: NODE, name: 'passwd.pdf', host: 'files.example', url: 'https://files.example/a/report.pdf', state: 'inProgress' })
    expect(JSON.stringify(items())).not.toContain('SECRET')
    writeFileSync(join(folder(), 'g1'), 'hello')
    progress('g1', 5, 5, 'completed')
    await waitFor(() => stateOf('g1') === 'completed', 'completed')
    expect(existsSync(join(folder(), 'g1'))).toBe(false)
    expect(readFileSync(join(folder(), 'passwd.pdf'), 'utf8')).toBe('hello')
    expect(statSync(join(folder(), 'passwd.pdf')).mode & 0o777).toBe(0o600)
    expect(items()[0]).toMatchObject({ received: 5, total: 5, name: 'passwd.pdf' })
    expect(events.filter((e) => e.k === 'download').map((e) => (e as { item: DownloadItem }).item.state)).toEqual(['inProgress', 'completed'])
  })

  it('a second file with the same name gets a numbered suffix', async () => {
    for (const g of ['a1', 'a2']) {
      begin(g, 'same.txt')
      await waitFor(() => stateOf(g) === 'inProgress', 'begin')
      writeFileSync(join(folder(), g), g)
      progress(g, 2, 2, 'completed')
      await waitFor(() => stateOf(g) === 'completed', 'done')
    }
    expect(items().map((i) => i.name).sort()).toEqual(['same (1).txt', 'same.txt'])
    expect(readFileSync(join(folder(), 'same (1).txt'), 'utf8')).toBe('a2')
  })

  it('flags an executable type as risky without blocking it', async () => {
    begin('r1', 'installer.pkg')
    await waitFor(() => items().length === 1, 'begin')
    expect(items()[0]).toMatchObject({ risky: true, state: 'inProgress' })
  })

  it('an unknown frame with no live page is canceled instead of kept invisibly', async () => {
    await rig.host.discard(NODE)
    begin('o1')
    await waitFor(() => rig.fake.calls.some((c) => c.method === CDP.cancelDownload && c.params.guid === 'o1'), 'cancel sent')
    expect(items()).toEqual([])
  })
})

describe('limits', () => {
  it('cancels a file announced over the size limit and says why', async () => {
    begin('big')
    await waitFor(() => items().length === 1, 'begin')
    progress('big', 10, DOWNLOAD_MAX_FILE_BYTES + 1)
    await waitFor(() => stateOf('big') === 'failed', 'failed')
    expect(items()[0]).toMatchObject({ failure: 'too_large' })
    expect(rig.fake.calls.some((c) => c.method === CDP.cancelDownload && c.params.guid === 'big')).toBe(true)
  })

  it('refuses a download that does not fit the profile quota (1000 bytes here)', async () => {
    begin('q1')
    await waitFor(() => items().length === 1, 'begin')
    progress('q1', 10, 5000)
    await waitFor(() => stateOf('q1') === 'failed', 'failed')
    expect(items()[0]).toMatchObject({ failure: 'quota' })
  })

  it('makes room by removing the oldest finished file before refusing', async () => {
    begin('old')
    await waitFor(() => items().length === 1, 'begin')
    writeFileSync(join(folder(), 'old'), 'x'.repeat(600))
    progress('old', 600, 600, 'completed')
    await waitFor(() => stateOf('old') === 'completed', 'done')
    begin('new')
    await waitFor(() => items().some((i) => i.id === 'new'), 'begin')
    progress('new', 10, 700)
    await waitFor(() => !items().some((i) => i.id === 'old'), 'old removed')
    expect(stateOf('new')).toBe('inProgress')
    expect(existsSync(join(folder(), 'report.pdf'))).toBe(false)
  })

  it('sends progress at most 4 times a second', async () => {
    begin('t1')
    await waitFor(() => items().length === 1, 'begin')
    const before = events.length
    for (let n = 1; n <= 5; n++) progress('t1', n, 100)
    await waitFor(() => items()[0]?.received === 5, 'progress folded')
    expect(events.length - before).toBe(0) // all inside the first window
    clock += DOWNLOAD_PROGRESS_MIN_INTERVAL_MS
    progress('t1', 6, 100)
    await waitFor(() => events.length - before === 1, 'one emit after the window')
    progress('t1', 7, 100)
    await waitFor(() => items()[0]?.received === 7, 'folded')
    expect(events.length - before).toBe(1)
  })
})

describe('user actions and failures', () => {
  it('cancel stops it, deletes the partial file and survives Chromium\'s own canceled event', async () => {
    begin('c1')
    await waitFor(() => items().length === 1, 'begin')
    writeFileSync(join(folder(), 'c1'), 'part')
    expect(rig.host.downloads!.cancel(NODE, 'c1')).toBe(true)
    expect(stateOf('c1')).toBe('canceled')
    expect(existsSync(join(folder(), 'c1'))).toBe(false)
    await waitFor(() => rig.fake.calls.some((c) => c.method === CDP.cancelDownload && c.params.guid === 'c1'), 'cancel sent')
    progress('c1', 4, 10, 'canceled')
    await new Promise((r) => setTimeout(r, 30))
    expect(stateOf('c1')).toBe('canceled')
    expect(rig.host.downloads!.cancel(NODE, 'c1')).toBe(false)
  })

  it('a cancel nobody asked for is a failure (the network dropped)', async () => {
    begin('f1')
    await waitFor(() => items().length === 1, 'begin')
    progress('f1', 4, 10, 'canceled')
    await waitFor(() => stateOf('f1') === 'failed', 'failed')
    expect(['network', 'disk_full']).toContain(items()[0].failure)
  })

  it('a lost browser connection fails what was running', async () => {
    begin('d1')
    await waitFor(() => items().length === 1, 'begin')
    rig.fake.drop()
    await waitFor(() => stateOf('d1') === 'failed', 'failed')
    expect(items()[0]).toMatchObject({ failure: 'interrupted' })
  })

  it('remove deletes the entry and its file and announces the new list', async () => {
    begin('x1', 'gone.txt')
    await waitFor(() => items().length === 1, 'begin')
    writeFileSync(join(folder(), 'x1'), 'bye')
    progress('x1', 3, 3, 'completed')
    await waitFor(() => stateOf('x1') === 'completed', 'done')
    expect(rig.host.downloads!.remove(NODE, 'x1')).toBe(true)
    expect(items()).toEqual([])
    expect(existsSync(join(folder(), 'gone.txt'))).toBe(false)
    expect(events.at(-1)).toMatchObject({ k: 'downloads', nodeId: NODE, items: [] })
    expect(rig.host.downloads!.remove(NODE, 'x1')).toBe(false)
  })

  it('another node cannot touch this node\'s download', async () => {
    begin('z1')
    await waitFor(() => items().length === 1, 'begin')
    expect(rig.host.downloads!.cancel('other', 'z1')).toBe(false)
    expect(rig.host.downloads!.remove('other', 'z1')).toBe(false)
    expect(rig.host.downloads!.file('other', 'z1')).toBeUndefined()
  })
})

describe('ask before saving', () => {
  it('a finished file waits for Keep, and Discard removes it', async () => {
    mode = 'ask'
    for (const g of ['k1', 'k2']) {
      begin(g, `${g}.txt`)
      await waitFor(() => stateOf(g) === 'inProgress', 'begin')
      writeFileSync(join(folder(), g), g)
      progress(g, 2, 2, 'completed')
      await waitFor(() => stateOf(g) === 'completed', 'done')
    }
    expect(items().every((i) => i.pending)).toBe(true)
    expect(rig.host.downloads!.keep(NODE, 'k1')).toBe(true)
    expect(items().find((i) => i.id === 'k1')?.pending).toBeUndefined()
    expect(rig.host.downloads!.keep(NODE, 'k1')).toBe(false)
    expect(rig.host.downloads!.remove(NODE, 'k2')).toBe(true)
    expect(existsSync(join(folder(), 'k2.txt'))).toBe(false)
    expect(existsSync(join(folder(), 'k1.txt'))).toBe(true)
  })
})
