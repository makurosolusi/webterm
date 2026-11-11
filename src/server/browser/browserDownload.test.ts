// "Download Chromium" without the network: the installer is injected. Single-flight, progress,
// success saves the override, failure and cancel leave no partial dirs, platform support, and the
// `advanced` fields the wizard reads (supported, headlessForced).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advancedView } from '../featureCapabilities.advanced'
import { createChromiumDownloader, MESSAGES, type Installer, type InstallJob } from './browserDownload'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'wt-dl-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const BUILD = 'chrome/linux-131.0.6778.85'
const BIN = `${BUILD}/chrome-linux64/chrome`
/** test-only: writes a partial build like the real installer would, then waits for `release`. */
function gatedInstaller(): { install: Installer; jobs: InstallJob[]; release(r: { ok: true } | { err: unknown }): void } {
  const jobs: InstallJob[] = []
  let settle: (r: { ok: true } | { err: unknown }) => void = () => undefined
  const install: Installer = async (job) => {
    jobs.push(job)
    mkdirSync(join(job.cacheDir, BUILD, 'chrome-linux64'), { recursive: true })
    writeFileSync(join(job.cacheDir, 'chrome', '131.0.6778.85-chrome-linux64.zip'), 'partial')
    const r = await new Promise<{ ok: true } | { err: unknown }>((resolve) => {
      settle = resolve
      job.signal.addEventListener('abort', () => resolve({ err: job.signal.reason }))
    })
    if ('err' in r) throw r.err
    rmSync(join(job.cacheDir, 'chrome', '131.0.6778.85-chrome-linux64.zip'))
    writeFileSync(join(job.cacheDir, BIN), '#!/bin/sh\n')
    return join(job.cacheDir, BIN)
  }
  return { install, jobs, release: (r) => settle(r) }
}
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('createChromiumDownloader', () => {
  it('single-flight with progress; success saves the binary as the override', async () => {
    const g = gatedInstaller()
    const d = createChromiumDownloader({ dataDir: () => data, install: g.install, platform: 'linux' })
    const setOverride = vi.fn(async () => undefined)
    expect(d.status().state).toBe('idle')
    expect(d.start(setOverride)?.state).toBe('downloading')
    expect(d.start(setOverride)?.state).toBe('downloading') // joins, no second job
    await vi.waitFor(() => expect(g.jobs).toHaveLength(1))
    expect(g.jobs[0]?.cacheDir).toBe(join(data, 'browsers'))
    g.jobs[0]?.onProgress(50, 200)
    expect(d.status()).toMatchObject({ state: 'downloading', percent: 25, bytes: 50, total: 200 })
    g.jobs[0]?.onProgress(10, 0)
    expect(d.status().percent).toBe(0) // size unknown
    g.release({ ok: true })
    await vi.waitFor(() => expect(d.status().state).toBe('done'))
    expect(d.status()).toMatchObject({ percent: 100, error: null, executablePath: join(data, 'browsers', BIN) })
    expect(setOverride).toHaveBeenCalledWith(join(data, 'browsers', BIN))
    expect(g.jobs).toHaveLength(1)
  })

  it('a failed download removes the dir it created and names disk space plainly; Retry starts again', async () => {
    const g = gatedInstaller()
    const d = createChromiumDownloader({ dataDir: () => data, install: g.install, platform: 'linux' })
    d.start(async () => undefined)
    await vi.waitFor(() => expect(g.jobs).toHaveLength(1))
    g.release({ err: errno('ENOSPC') })
    await vi.waitFor(() => expect(d.status().state).toBe('failed'))
    expect(d.status().error).toBe(MESSAGES.noSpace)
    expect(existsSync(join(data, 'browsers'))).toBe(false)
    expect(d.start(async () => undefined)?.state).toBe('downloading')
    await vi.waitFor(() => expect(g.jobs).toHaveLength(2))
  })

  it('a failure keeps builds that were already there and drops only what this job added', async () => {
    const old = join(data, 'browsers', 'chrome', 'linux-130.0.1')
    mkdirSync(old, { recursive: true })
    const g = gatedInstaller()
    const d = createChromiumDownloader({ dataDir: () => data, install: g.install, platform: 'linux' })
    d.start(async () => undefined)
    await vi.waitFor(() => expect(g.jobs).toHaveLength(1))
    g.release({ err: errno('EACCES') })
    await vi.waitFor(() => expect(d.status().state).toBe('failed'))
    expect(d.status().error).toBe(MESSAGES.noPermission)
    expect(readdirSync(join(data, 'browsers', 'chrome'))).toEqual(['linux-130.0.1'])
  })

  it('a network error reads as a download failure; a save failure after install is reported', async () => {
    const d = createChromiumDownloader({ dataDir: () => data, install: async () => { throw new Error('fetch failed') }, platform: 'darwin' })
    d.start(async () => undefined)
    await vi.waitFor(() => expect(d.status().state).toBe('failed'))
    expect(d.status().error).toBe(MESSAGES.network)
    const d2 = createChromiumDownloader({ dataDir: () => data, install: async () => '/x/chrome', platform: 'darwin' })
    d2.start(async () => { throw new Error('write_failed') })
    await vi.waitFor(() => expect(d2.status().state).toBe('failed'))
    expect(d2.status()).toMatchObject({ error: MESSAGES.saveFailed, executablePath: '/x/chrome' })
  })

  it('cancel aborts the job, returns to idle and leaves nothing behind', async () => {
    const g = gatedInstaller()
    const d = createChromiumDownloader({ dataDir: () => data, install: g.install, platform: 'linux' })
    const setOverride = vi.fn(async () => undefined)
    d.start(setOverride)
    await vi.waitFor(() => expect(g.jobs).toHaveLength(1))
    d.cancel()
    expect(g.jobs[0]?.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(d.status().state).toBe('idle'))
    expect(d.status()).toMatchObject({ percent: 0, error: null, executablePath: null })
    expect(existsSync(join(data, 'browsers'))).toBe(false)
    expect(setOverride).not.toHaveBeenCalled()
  })

  it('an unsupported platform does not start', () => {
    const install = vi.fn<Installer>()
    const d = createChromiumDownloader({ dataDir: () => data, install, platform: 'aix' })
    expect(d.start(async () => undefined)).toBeNull()
    expect(install).not.toHaveBeenCalled()
  })
})

describe('advanced fields for the Browser step', () => {
  it('chromiumDownload.supported follows the platform and carries the running state', () => {
    expect(advancedView({}, '/d', undefined, 'aix').chromiumDownload).toEqual({ supported: false, state: 'idle', percent: 0 })
    expect(advancedView({}, '/d', { state: 'downloading', percent: 40 }, 'darwin').chromiumDownload).toEqual({ supported: true, state: 'downloading', percent: 40 })
  })

  it('headlessForced is no_display only on Linux without a display, whatever the headless setting', () => {
    expect(advancedView({}, '/d', undefined, 'linux').headlessForced).toBe('no_display')
    expect(advancedView({ WEBTERM_BROWSER_HEADLESS: 'on' }, '/d', undefined, 'linux').headlessForced).toBe('no_display')
    expect(advancedView({ DISPLAY: ':0' }, '/d', undefined, 'linux').headlessForced).toBeNull()
    expect(advancedView({ WAYLAND_DISPLAY: 'wayland-0' }, '/d', undefined, 'linux').headlessForced).toBeNull()
    expect(advancedView({}, '/d', undefined, 'darwin').headlessForced).toBeNull()
  })
})

describe('the package loads only when a download starts', () => {
  it('no static import of @puppeteer/browsers in the server or the client', async () => {
    const { readFileSync, readdirSync: ls } = await import('node:fs')
    const src = join(import.meta.dirname, '..', '..')
    const offenders = (['server', 'client', 'shared'] as const).flatMap((d) => (ls(join(src, d), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /^\s*import[^(]*['"]@puppeteer\/browsers['"]/m.test(readFileSync(join(src, d, f), 'utf8').replace(/^import type .*$/gm, '')))
      .map((f) => `${d}/${f}`))
    expect(offenders).toEqual([])
    expect(readFileSync(join(src, 'server', 'browser', 'browserDownload.ts'), 'utf8')).toContain("await import('@puppeteer/browsers')")
  })
})
