// "Download Chromium" without the network: the managed install is injected. Single-flight, progress,
// automatic retry for network failures only, failure kinds, cancel, platform support, and the
// `advanced` fields the wizard reads (supported, headlessForced). It never saves WEBTERM_BROWSER_BIN.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { advancedView } from '../featureCapabilities.advanced'
import { ChromeDownloadError } from './chromium.managed'
import { createChromiumDownloader, MESSAGES, RETRY_DELAYS_MS, type Installer } from './browserDownload'

const BIN = '/data/browser/chrome-for-testing/1/chrome-linux64/chrome'
const net = (): ChromeDownloadError => new ChromeDownloadError('network', 'down')
const errno = (code: string): Error => new Error('x', { cause: Object.assign(new Error(code), { code }) })
const make = (install: Installer, delays: readonly number[] = [0, 0, 0]) => createChromiumDownloader({ dataDir: () => '/data', install, delays, platform: 'linux', arch: 'x64' })

describe('createChromiumDownloader', () => {
  it('installs into the managed root, single-flight, with progress; ends done with the managed path', async () => {
    let release: () => void = () => undefined
    const calls: { root: string; onProgress?: (b: number, t: number) => void }[] = []
    const d = make(async (root, deps) => { calls.push({ root, onProgress: deps.onProgress }); await new Promise<void>((r) => { release = r }); return BIN })
    expect(d.status().state).toBe('idle')
    expect(d.start()?.state).toBe('downloading')
    expect(d.start()?.state).toBe('downloading') // joins
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.root).toBe(join('/data', 'browser', 'chrome-for-testing'))
    calls[0]?.onProgress?.(50, 200)
    expect(d.status()).toMatchObject({ percent: 25, bytes: 50, total: 200 })
    calls[0]?.onProgress?.(10, 0)
    expect(d.status().percent).toBe(0)
    release()
    await vi.waitFor(() => expect(d.status().state).toBe('done'))
    expect(d.status()).toMatchObject({ percent: 100, error: null, errorKind: null, executablePath: BIN })
    expect(calls).toHaveLength(1)
  })

  it('retries network failures with the configured pauses, then succeeds', async () => {
    let n = 0
    const install = vi.fn<Installer>(async () => { if (++n < 3) throw net(); return BIN })
    const d = make(install)
    d.start()
    await vi.waitFor(() => expect(d.status().state).toBe('done'))
    expect(install).toHaveBeenCalledTimes(3)
    expect(d.status().retry).toBeNull()
  })

  it('shows retrying (attempt of max) during the pause and gives up as network after the cap', async () => {
    const install = vi.fn<Installer>(async () => { throw net() })
    const d = make(install, [50, 50])
    d.start()
    await vi.waitFor(() => expect(d.status()).toMatchObject({ state: 'retrying', retry: { attempt: 2, max: 3 } }))
    await vi.waitFor(() => expect(d.status().state).toBe('failed'))
    expect(install).toHaveBeenCalledTimes(3)
    expect(d.status()).toMatchObject({ errorKind: 'network', error: MESSAGES.network })
    expect(d.start()?.state).toBe('downloading') // Try again
  })

  it('never retries a checksum mismatch, a disk error or another failure', async () => {
    const cases: [unknown, keyof typeof MESSAGES][] = [
      [new ChromeDownloadError('checksum', 'SHA-256 mismatch'), 'checksum'], [errno('ENOSPC'), 'disk'], [new Error('boom'), 'other'],
    ]
    for (const [err, kind] of cases) {
      const install = vi.fn<Installer>(async () => { throw err })
      const d = make(install)
      d.start()
      await vi.waitFor(() => expect(d.status().state).toBe('failed'))
      expect(install).toHaveBeenCalledTimes(1)
      expect(d.status()).toMatchObject({ errorKind: kind, error: MESSAGES[kind] })
    }
  })

  it('cancel while downloading or while waiting to retry returns to idle', async () => {
    const hang = vi.fn<Installer>((_r, deps) => new Promise((_res, rej) => deps.signal?.addEventListener('abort', () => rej(deps.signal?.reason))))
    const d = make(hang)
    d.start()
    await vi.waitFor(() => expect(hang).toHaveBeenCalled())
    d.cancel()
    await vi.waitFor(() => expect(d.status().state).toBe('idle'))
    const d2 = make(async () => { throw net() }, [60_000])
    d2.start()
    await vi.waitFor(() => expect(d2.status().state).toBe('retrying'))
    d2.cancel()
    await vi.waitFor(() => expect(d2.status()).toMatchObject({ state: 'idle', retry: null, error: null }))
  })

  it('has a bounded retry schedule and an unsupported platform does not start', () => {
    expect(RETRY_DELAYS_MS.length).toBeGreaterThan(0)
    expect(RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5)
    const install = vi.fn<Installer>()
    expect(createChromiumDownloader({ dataDir: () => '/d', install, platform: 'linux', arch: 'arm64' }).start()).toBeNull()
    expect(install).not.toHaveBeenCalled()
  })

  it('the download path no longer touches WEBTERM_BROWSER_BIN or @puppeteer/browsers', () => {
    const src = readFileSync(new URL('./browserDownload.ts', import.meta.url), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(src).not.toMatch(/BROWSER_BIN|chromiumPath|puppeteer|setOverride/)
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
