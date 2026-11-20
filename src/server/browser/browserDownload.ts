// "Download Chromium" button: triggers the SAME managed install a first Browser launch does (locked
// version, pinned SHA-256, `<data dir>/browser/chrome-for-testing/<version>/`) and never saves
// `WEBTERM_BROWSER_BIN`. One download at a time, progress, cancel, automatic retry with growing pauses
// for network failures (restarting clean: the archive lives only in memory, so no partial file exists),
// and a failure kind the UI can word. A checksum mismatch is refused, never retried.
import type { ChromiumDownloadErrorKind, ChromiumDownloadStatus } from '../../shared/featureCapabilities'
import { createLogger } from '../logs'
import { cftPlatform, ensureManaged, failureKind, managedRoot, type ManagedDeps } from './chromium.managed'

const log = createLogger('browser.download')

export type DownloadStatus = ChromiumDownloadStatus
const IDLE_STATUS: DownloadStatus = { state: 'idle', percent: 0, bytes: 0, total: 0, error: null, executablePath: null, errorKind: null, retry: null }

/** Pauses before each automatic retry; its length is the retry cap (so 1 + 3 attempts). */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000]

export const downloadSupported = (platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean => cftPlatform(platform, arch) !== null

export const MESSAGES: Record<ChromiumDownloadErrorKind, string> = {
  network: 'Chromium could not be downloaded. Check the internet connection and try again.',
  disk: 'Chromium could not be saved: the disk is full or webterm cannot write to its data folder.',
  checksum: 'The downloaded file did not match the expected checksum, so it was discarded. Try again; if it keeps failing, the network may be altering the download.',
  other: 'Chromium could not be installed. Try again.',
}

/** Runs one managed install attempt; the seam tests replace (never the network). */
export type Installer = (root: string, deps: ManagedDeps) => Promise<string>

export interface ChromiumDownloader {
  status(): DownloadStatus
  /** Start (or join) the download. null = platform unsupported. */
  start(): DownloadStatus | null
  cancel(): DownloadStatus
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

/** Single-flight downloader; `install`, `delays`, `platform` and `arch` are test seams. */
export function createChromiumDownloader(o: {
  dataDir: () => string; install?: Installer; delays?: readonly number[]; platform?: NodeJS.Platform; arch?: string
}): ChromiumDownloader {
  const install = o.install ?? ensureManaged
  const delays = o.delays ?? RETRY_DELAYS_MS
  let s: DownloadStatus = { ...IDLE_STATUS }
  let abort: AbortController | null = null
  const status = (): DownloadStatus => ({ ...s })

  async function run(ac: AbortController): Promise<void> {
    const root = managedRoot(o.dataDir())
    const onProgress = (bytes: number, total: number): void => { s = { ...s, bytes, total, percent: total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : 0 } }
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const path = await install(root, { signal: ac.signal, onProgress })
          if (ac.signal.aborted) break
          s = { ...s, state: 'done', percent: 100, retry: null, executablePath: path }
          log.info('download.done', 'Managed Chromium downloaded', { attempt })
          return
        } catch (e) {
          if (ac.signal.aborted) break
          const kind = failureKind(e)
          const pause = delays[attempt - 1]
          log.warn('download.failed', 'Chromium download failed', { kind, attempt, willRetry: kind === 'network' && pause !== undefined, cause: e instanceof Error ? e.name : 'error' })
          if (kind !== 'network' || pause === undefined) { s = { ...s, state: 'failed', error: MESSAGES[kind], errorKind: kind, retry: null }; return }
          s = { ...s, state: 'retrying', percent: 0, bytes: 0, total: 0, retry: { attempt: attempt + 1, max: delays.length + 1 } }
          await sleep(pause, ac.signal)
          if (ac.signal.aborted) break
          s = { ...s, state: 'downloading' }
        }
      }
      log.info('download.cancelled', 'Chromium download cancelled')
      s = { ...IDLE_STATUS }
    } finally {
      abort = null
    }
  }

  return {
    status,
    start() {
      if (!downloadSupported(o.platform, o.arch)) return null
      if (s.state === 'downloading' || s.state === 'retrying') return status()
      const ac = new AbortController()
      abort = ac
      s = { ...IDLE_STATUS, state: 'downloading' }
      void run(ac)
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
/** The process-wide downloader (state is per server process; a restart finds the build on disk). */
export function chromiumDownloader(dataDir: () => string): ChromiumDownloader {
  return (shared ??= createChromiumDownloader({ dataDir }))
}
