// webterm's own browser: a version-locked Chrome for Testing under `<data dir>/browser/chrome-for-testing/<version>/`.
// Never the user's installed Chrome/Brave/Edge (own app identity, no desktop focus, no shared OS handlers).
// Downloaded once, over HTTPS only, from Google's official bucket; `fetch`/fs are injected so tests never hit the network.
import { createHash } from 'node:crypto'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logs/logger'
import { extractZip } from './chromium.managed.zip'

const log = createLogger('browser.managed')

/**
 * Locked build. Source: Stable channel of
 * https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json (checked 2026-11-19).
 * Bump deliberately: change this, clear `CHROME_SHA256`, regenerate pins with `--print-sha256`.
 */
export const CHROME_FOR_TESTING_VERSION = '158.0.8127.36'
export const CFT_BASE_URL = 'https://storage.googleapis.com/chrome-for-testing-public'
export const MANAGED_SUBDIR = join('browser', 'chrome-for-testing')
export const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export type CftPlatform = 'mac-arm64' | 'mac-x64' | 'linux64' | 'win64'

/**
 * Pinned SHA-256 of each platform archive for `CHROME_FOR_TESTING_VERSION` (Chrome for Testing publishes no checksum).
 * Computed 2026-11-20 by `bun scripts/fetch-chrome.ts --print-sha256` and confirmed by an independent curl + `shasum -a 256`
 * of the same storage.googleapis.com URLs. A bump must clear and regenerate these the same way (two downloads must agree).
 */
export const CHROME_SHA256: Partial<Record<CftPlatform, string>> = {
  'mac-arm64': 'b86d3b393def1f87d369b022abff0a51acb015d6fcb79ddfd1c379c9d72fbbe2',
  'mac-x64': '1390e9b1386a1fd8ec2c4940b9ff59cbbda71b896b85182d7efbd73c58213802',
  linux64: 'dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7',
  win64: '6a8ad290952cc612c7777ffb3eb62f345539a2a1a8d440cfac190c6d36b34d2c',
}

const BIN_IN_ARCHIVE: Record<CftPlatform, string> = {
  'mac-arm64': 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'mac-x64': 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  linux64: 'chrome-linux64/chrome',
  win64: 'chrome-win64/chrome.exe',
}

/** Chrome for Testing platform of this machine; null when no build exists (e.g. linux arm64). */
export function cftPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CftPlatform | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null
  if (arch !== 'x64') return null
  return platform === 'linux' ? 'linux64' : platform === 'win32' ? 'win64' : null
}

export const archiveUrl = (p: CftPlatform, version: string = CHROME_FOR_TESTING_VERSION): string => `${CFT_BASE_URL}/${version}/${p}/chrome-${p}.zip`

/** Folder that holds `<version>/` dirs under a data dir. */
export const managedRoot = (dataDir: string): string => join(dataDir, MANAGED_SUBDIR)

/** Where the managed binary lives (or will live); null on an unsupported platform. */
export function managedBinaryPath(root: string, p: CftPlatform | null = cftPlatform(), version: string = CHROME_FOR_TESTING_VERSION): string | null {
  return p ? join(root, version, BIN_IN_ARCHIVE[p]) : null
}

/** Why a managed download failed: `network` is transient (retried), `checksum` means the bytes are not the pinned build, `disk` = cannot write. */
export type ChromeFailureKind = 'network' | 'disk' | 'checksum' | 'other'
export class ChromeDownloadError extends Error {
  constructor(readonly kind: ChromeFailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ChromeDownloadError'
  }
}
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EMFILE'])
/** Failure kind of anything `installManaged` threw (walks the cause chain for errno codes). */
export function failureKind(e: unknown): ChromeFailureKind {
  for (let c: unknown = e, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    if (c instanceof ChromeDownloadError && c.kind !== 'other') return c.kind
    if (DISK_CODES.has((c as NodeJS.ErrnoException).code ?? '')) return 'disk'
  }
  return 'other'
}

export interface ManagedDeps {
  /** Cancels the download (and nothing is left behind: the archive is only ever in memory). */
  signal?: AbortSignal
  onProgress?: (bytes: number, total: number) => void
  fetch?: typeof fetch
  platform?: CftPlatform | null
  version?: string
  sha256?: Partial<Record<CftPlatform, string>>
  exists?: (p: string) => boolean
}

/** Download the archive into memory with a size cap and timeout; the caller verifies and extracts it. */
async function download(url: string, fetchFn: typeof fetch, signal?: AbortSignal, onProgress?: ManagedDeps['onProgress']): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new Error(`chrome download: refusing non-HTTPS url ${url}`)
  let res: Response
  try {
    res = await fetchFn(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (e) {
    throw new ChromeDownloadError('network', `chrome download: request to ${url} failed`, e)
  }
  if (!res.ok || !res.body) throw new ChromeDownloadError('network', `chrome download: ${url} answered ${res.status}`)
  if (Number(res.headers.get('content-length')) > MAX_ARCHIVE_BYTES) throw new ChromeDownloadError('other', `chrome download: ${url} is larger than ${MAX_ARCHIVE_BYTES} bytes`)
  const chunks: Buffer[] = []
  const total = Number(res.headers.get('content-length')) || 0
  let size = 0
  try {
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += c.length
      if (size > MAX_ARCHIVE_BYTES) throw new ChromeDownloadError('other', `chrome download: ${url} exceeded ${MAX_ARCHIVE_BYTES} bytes`)
      chunks.push(Buffer.from(c))
      onProgress?.(size, total)
    }
  } catch (e) {
    throw new ChromeDownloadError(e instanceof ChromeDownloadError ? 'other' : 'network', `chrome download: reading ${url} failed`, e)
  }
  return Buffer.concat(chunks)
}

/** Hex SHA-256 of the official archive for a platform (used by `--print-sha256` to create a pin). */
export async function archiveSha256(p: CftPlatform, fetchFn: typeof fetch = fetch, version?: string): Promise<string> {
  return createHash('sha256').update(await download(archiveUrl(p, version), fetchFn)).digest('hex')
}

/**
 * Ensure the managed build exists under `root` (`<root>/<version>/...`) and return its binary path. Idempotent:
 * an existing binary is returned untouched. Extracts into a temp dir and renames, so a crash never leaves a half build.
 */
export async function installManaged(root: string, deps: ManagedDeps = {}): Promise<string> {
  const p = deps.platform === undefined ? cftPlatform() : deps.platform
  if (!p) throw new Error(`chrome download: no Chrome for Testing build for ${process.platform}/${process.arch}`)
  const version = deps.version ?? CHROME_FOR_TESTING_VERSION
  const bin = managedBinaryPath(root, p, version) as string
  if ((deps.exists ?? existsSync)(bin)) return bin
  log.info('managed.download', 'Downloading webterm\'s own Chrome for Testing (one time)', { version, platform: p })
  const zip = await download(archiveUrl(p, version), deps.fetch ?? fetch, deps.signal, deps.onProgress)
  const pin = (deps.sha256 ?? CHROME_SHA256)[p]
  if (pin) {
    const got = createHash('sha256').update(zip).digest('hex')
    if (got !== pin.toLowerCase()) throw new ChromeDownloadError('checksum', `chrome download: SHA-256 mismatch for ${p} ${version} (expected ${pin}, got ${got})`)
  } else {
    log.warn('managed.unpinned', 'No SHA-256 pin for this Chrome archive; trusting the HTTPS download', { version, platform: p })
  }
  const final = join(root, version)
  const tmp = `${final}.partial-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  try {
    extractZip(zip, tmp)
    if (!existsSync(join(tmp, BIN_IN_ARCHIVE[p]))) throw new Error(`chrome download: archive has no ${BIN_IN_ARCHIVE[p]}`)
    rmSync(final, { recursive: true, force: true })
    renameSync(tmp, final)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`chrome download: installing ${version} into ${final} failed`, { cause: e })
  }
  log.info('managed.ready', 'Managed Chrome for Testing installed', { version })
  return bin
}

const inflight = new Map<string, Promise<string>>()
/** Single-flight `installManaged` per root: concurrent first launches share one download. */
export function ensureManaged(root: string, deps: ManagedDeps = {}): Promise<string> {
  let p = inflight.get(root)
  if (!p) {
    p = installManaged(root, deps).finally(() => inflight.delete(root))
    inflight.set(root, p)
  }
  return p
}

