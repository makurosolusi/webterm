// "Download Chromium" for a machine with no browser: Chrome for Testing (stable) from Google's
// official bucket, through @puppeteer/browsers, into `<data dir>/browsers` (dev:fresh gets its own,
// its root is swept). One download at a time; progress, cancel, and nothing half-written on failure.
// The package is imported only when a download starts, never at boot or in the client bundle.
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ChromiumDownloadStatus } from '../../shared/featureCapabilities'
import { createLogger } from '../logs'
import { BROWSERS_SUBDIR } from './chromium.launch'

const log = createLogger('browser.download')

/** `percent` 0-100 (0 while the size is unknown); `error` = plain sentence for the user when `failed`. */
export type DownloadStatus = ChromiumDownloadStatus
const IDLE_STATUS: DownloadStatus = { state: 'idle', percent: 0, bytes: 0, total: 0, error: null, executablePath: null }

export interface InstallJob { cacheDir: string; signal: AbortSignal; onProgress(bytes: number, total: number): void }
/** Downloads and unpacks one build under `cacheDir`; resolves to its executable. */
export type Installer = (job: InstallJob) => Promise<string>

/** Platforms `detectBrowserPlatform()` of @puppeteer/browsers maps to a build (detectPlatform.ts), mirrored so a GET never loads the package. */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux', 'win32']
export const downloadSupported = (platform: NodeJS.Platform = process.platform): boolean => SUPPORTED_PLATFORMS.includes(platform)

export const MESSAGES = {
  noSpace: 'Not enough free disk space to download Chromium (about 600 MB is needed).',
  noPermission: 'webterm cannot write to its data folder, so Chromium cannot be saved. Check the folder permissions.',
  network: 'Chromium could not be downloaded. Check the internet connection and try again.',
  saveFailed: 'Chromium was downloaded, but webterm could not save it as the browser to use.',
} as const

/** Error -> one plain sentence (disk space and permission named; the rest is a download failure). */
export function plainError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return MESSAGES.noSpace
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return MESSAGES.noPermission
  return MESSAGES.network
}

/** Paths up to two levels below `dir` (`chrome`, `chrome/<build>`, `chrome/<archive>`): what a failed job may have added. */
function entries(dir: string): Set<string> {
  const out = new Set<string>()
  if (!existsSync(dir)) return out
  for (const a of readdirSync(dir)) {
    out.add(a)
    const sub = join(dir, a)
    if (statSync(sub).isDirectory()) for (const b of readdirSync(sub)) out.add(join(a, b))
  }
  return out
}

/** The real installer: resolve the stable build, stream the archive ourselves (abortable), then let install() unpack it. */
export const puppeteerInstaller: Installer = async ({ cacheDir, signal, onProgress }) => {
  const b = await import('@puppeteer/browsers')
  const platform = b.detectBrowserPlatform()
  if (!platform) throw new Error('chromium download: this platform has no Chrome for Testing build')
  const buildId = await b.resolveBuildId(b.Browser.CHROME, platform, b.BrowserTag.STABLE)
  const url = b.getDownloadUrl(b.Browser.CHROME, platform, buildId)
  const root = new b.Cache(cacheDir).browserRoot(b.Browser.CHROME)
  await mkdir(root, { recursive: true })
  // Same name install() looks for (install.ts installUrl `${buildId}-${fileName}`): it unpacks this file instead of downloading again, then deletes it.
  const archive = join(root, `${buildId}-${decodeURIComponent(url.pathname).split('/').pop()}`)
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`chromium download: server answered ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let bytes = 0
  const count = new Transform({ transform(chunk: Buffer, _enc, cb) { bytes += chunk.length; onProgress(bytes, total); cb(null, chunk) } })
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), count, createWriteStream(archive), { signal })
  signal.throwIfAborted()
  return (await b.install({ browser: b.Browser.CHROME, buildId, platform, cacheDir })).executablePath
}

export interface ChromiumDownloader {
  status(): DownloadStatus
  /** Start (or join) the download; `setOverride` saves the binary as the browser to use once installed. null = platform unsupported. */
  start(setOverride: (path: string) => Promise<void>): DownloadStatus | null
  cancel(): DownloadStatus
}

/** Single-flight downloader; `install` and `platform` are seams for tests (they never touch the network). */
export function createChromiumDownloader(o: { dataDir: () => string; install?: Installer; platform?: NodeJS.Platform }): ChromiumDownloader {
  const install = o.install ?? puppeteerInstaller
  let s: DownloadStatus = { ...IDLE_STATUS }
  let abort: AbortController | null = null
  const status = (): DownloadStatus => ({ ...s })

  async function run(ac: AbortController, setOverride: (path: string) => Promise<void>): Promise<void> {
    const cacheDir = join(o.dataDir(), BROWSERS_SUBDIR)
    const existed = existsSync(cacheDir)
    const before = entries(cacheDir)
    let path: string
    try {
      path = await install({
        cacheDir, signal: ac.signal,
        onProgress: (bytes, total) => { s = { ...s, bytes, total, percent: total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : 0 } },
      })
      if (ac.signal.aborted) throw ac.signal.reason
    } catch (e) {
      // Nothing half-written survives: drop what this job added (or the whole dir it created).
      try {
        if (!existed) await rm(cacheDir, { recursive: true, force: true })
        else for (const p of [...entries(cacheDir)].filter((p) => !before.has(p))) await rm(join(cacheDir, p), { recursive: true, force: true })
      } catch (err) {
        log.warn('download.cleanup_failed', 'Cannot remove a partial Chromium download', { cause: (err as NodeJS.ErrnoException).code ?? 'error' })
      }
      if (ac.signal.aborted) {
        log.info('download.cancelled', 'Chromium download cancelled')
        s = { ...IDLE_STATUS }
      } else {
        log.warn('download.failed', 'Chromium download failed', { cause: (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.name : 'error') })
        s = { ...s, state: 'failed', error: plainError(e) }
      }
      return
    } finally {
      abort = null
    }
    try {
      await setOverride(path)
      s = { ...s, state: 'done', percent: 100, executablePath: path }
      log.info('download.done', 'Chromium downloaded and selected')
    } catch (e) {
      log.warn('download.save_failed', 'Cannot save the downloaded Chromium as the browser', { cause: e instanceof Error ? e.name : 'error' })
      s = { ...s, state: 'failed', error: MESSAGES.saveFailed, executablePath: path }
    }
  }

  return {
    status,
    start(setOverride) {
      if (!downloadSupported(o.platform)) return null
      if (s.state === 'downloading') return status()
      const ac = new AbortController()
      abort = ac
      s = { ...IDLE_STATUS, state: 'downloading' }
      void run(ac, setOverride)
      return status()
    },
    cancel() {
      abort?.abort(new Error('chromium download cancelled'))
      return status()
    },
  }
}

let shared: ChromiumDownloader | undefined
/** Status of the process-wide downloader; idle before the first download. */
export const sharedDownloadStatus = (): DownloadStatus => shared?.status() ?? { ...IDLE_STATUS }
/** The process-wide downloader (state is per server process; a restart finds the build through discovery). */
export function chromiumDownloader(dataDir: () => string): ChromiumDownloader {
  return (shared ??= createChromiumDownloader({ dataDir }))
}
