// Cari biner Chromium dan jalankan satu proses per profil. Tidak pernah dipanggil test
// dengan biner nyata: `spawn`, `exists`, `readFile`, `sleep` diinjeksi.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { LaunchReason } from '../../shared/browser.contract'
import { buildChromiumArgs, CDP_LOOPBACK, headlessReason, profileDirFor } from './chromium.flags'
import { createLogger } from '../logs'
import { childEnv } from '../childEnv'
import { lockHolder, reclaimProfile } from './chromium.profileLock'
import type { ProfileLockDeps } from './chromium.profileLock'

const log = createLogger('browser.launch')
export const START_TIMEOUT_MS = 20_000
export const POLL_MS = 100
export const KILL_GRACE_MS = 3_000
const STDERR_TAIL_CHARS = 4_096
const PROFILE_DIR_MODE = 0o700
const ACTIVE_PORT_FILE = 'DevToolsActivePort'

// Aplikasi macOS berbasis Chromium yang mendukung CDP + DevToolsActivePort. Arc sengaja tidak
// ada: tidak mendukung CDP secara andal.
const MAC_APPS = ['Google Chrome', 'Chromium', 'Google Chrome Canary', 'Microsoft Edge', 'Brave Browser'] as const

/** Lokasi umum macOS/Linux bila `WEBTERM_BROWSER_BIN` kosong; urutan = prioritas. */
export const BIN_CANDIDATES = [
  ...MAC_APPS.map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
] as const

/** Nama perintah yang dicari di tiap direktori `PATH` setelah lokasi umum. */
export const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] as const

/** Cache Playwright (macOS, Linux) relatif ke HOME; dicari paling akhir. */
const PLAYWRIGHT_CACHES = ['Library/Caches/ms-playwright', '.cache/ms-playwright'] as const
/** Biner di dalam `chromium-<rev>/` lintas versi Playwright (lama: Chromium.app; baru: Chrome for Testing). */
const PLAYWRIGHT_BINS = [
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux/chrome', 'chrome-linux64/chrome',
] as const
const PLAYWRIGHT_DIR = /^chromium-(\d+)$/

/** `<data dir>/browsers`: where "Download Chromium" installs (browserDownload.ts), layout of @puppeteer/browsers' Cache. */
export const BROWSERS_SUBDIR = 'browsers'
/** Cache layout `<cacheDir>/chrome/<platform>-<buildId>/<bin>` (Chrome for Testing). */
const DOWNLOADED_BROWSER = 'chrome'
const DOWNLOADED_BINS = [...PLAYWRIGHT_BINS, 'chrome-linux-arm64/chrome'] as const
const DOWNLOADED_DIR = /^[a-z0-9_]+-(\d+(?:\.\d+)*)$/

/** Data dir as config.ts `dataDir()` derives it, from an env snapshot (pure: tests pass their own); null without either var. */
export const dataDirOf = (env: Record<string, string | undefined>): string | null =>
  env.WEBTERM_DATA_DIR || (env.HOME ? join(env.HOME, '.webterm-server') : null)

/** Newest version first (`131.0.6778.85` > `131.0.6778.9`). */
const byVersionDesc = (a: string, b: string): number => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
  return 0
}

/** Binaries a previous "Download Chromium" left in `<data dir>/browsers`, newest build first (survives restarts without the override). */
export function downloadedCandidates(dataDir: string, listDir: ListDir = defaultListDir): string[] {
  const root = join(dataDir, BROWSERS_SUBDIR, DOWNLOADED_BROWSER)
  return listDir(root)
    .map((name) => ({ name, version: DOWNLOADED_DIR.exec(name)?.[1] }))
    .filter((d): d is { name: string; version: string } => d.version !== undefined)
    .sort((a, b) => byVersionDesc(a.version, b.version))
    .flatMap((d) => DOWNLOADED_BINS.map((b) => join(root, d.name, b)))
}

export type ListDir = (dir: string) => string[]
const defaultListDir: ListDir = (dir) => (existsSync(dir) ? readdirSync(dir) : [])

/** Semua biner Chromium yang ADA di disk, urut prioritas: lokasi umum -> PATH -> unduhan webterm -> cache Playwright (revisi terbaru dulu). */
export function chromiumCandidates(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
  listDir: ListDir = defaultListDir,
): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((d) => PATH_NAMES.map((n) => join(d, n)))
  const home = env.HOME
  const fromPlaywright = home ? PLAYWRIGHT_CACHES.flatMap((c) => {
    const root = join(home, c)
    return listDir(root)
      .map((name) => ({ name, rev: Number(PLAYWRIGHT_DIR.exec(name)?.[1] ?? NaN) }))
      .filter((d) => Number.isFinite(d.rev))
      .sort((a, b) => b.rev - a.rev)
      .flatMap((d) => PLAYWRIGHT_BINS.map((b) => join(root, d.name, b)))
  }) : []
  const data = dataDirOf(env)
  const fromDownload = data ? downloadedCandidates(data, listDir) : []
  return [...new Set([...BIN_CANDIDATES, ...fromPath, ...fromDownload, ...fromPlaywright])].filter((p) => exists(p))
}

export class LaunchError extends Error {
  constructor(
    readonly code: 'no_binary' | 'sandbox_unavailable' | 'launch_failed' | 'profile_locked', message: string, cause?: unknown,
    /** Specific cause for the log and the UI; absent = derived from `code` by `launchReason`. */
    readonly reason?: LaunchReason,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LaunchError'
  }
}

const REASON_OF_CODE: Record<LaunchError['code'], LaunchReason> = {
  no_binary: 'bin_not_found', sandbox_unavailable: 'sandbox_unavailable', profile_locked: 'profile_locked', launch_failed: 'crashed_on_start',
}

/** Specific cause of a failed launch; anything that is not a `LaunchError` (e.g. the CDP connect after launch) = `connect_failed`. */
export function launchReason(err: unknown): LaunchReason {
  return err instanceof LaunchError ? (err.reason ?? REASON_OF_CODE[err.code]) : 'connect_failed'
}

/** Path biner: override eksplisit (harus ada; TIDAK jatuh ke otomatis) -> kandidat pertama -> `LaunchError('no_binary')`. */
export function resolveBinary(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
  listDir: ListDir = defaultListDir,
): string {
  const explicit = env[ENV_BROWSER.bin]?.trim()
  if (explicit) {
    if (!exists(explicit)) throw new LaunchError('no_binary', `${ENV_BROWSER.bin} points to a missing file`)
    return explicit
  }
  const found = chromiumCandidates(env, exists, listDir)[0]
  if (!found) throw new LaunchError('no_binary', `no Chromium found; install one or set ${ENV_BROWSER.bin}`)
  return found
}

/** Deteksi biner Chromium tanpa melempar: override menang (harus ada), lalu kandidat otomatis; null = hilang. */
export function detectChromium(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
  listDir: ListDir = defaultListDir,
): { path: string; source: 'override' | 'auto' } | null {
  try {
    return { path: resolveBinary(env, exists, listDir), source: env[ENV_BROWSER.bin]?.trim() ? 'override' : 'auto' }
  } catch (e) {
    if (e instanceof LaunchError && e.code === 'no_binary') return null
    throw e
  }
}

/** Bagian ChildProcess yang dipakai (memudahkan fake di test). */
export interface ChildLike {
  pid?: number
  stderr?: { on(ev: 'data', cb: (b: Buffer | string) => void): unknown } | null
  once(ev: 'exit' | 'error', cb: (...a: any[]) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  kill(sig?: NodeJS.Signals): boolean
}
export interface LaunchDeps extends ProfileLockDeps {
  spawn?: (bin: string, args: string[]) => ChildLike
  readFile?: (path: string) => string | null
  sleep?: (ms: number) => Promise<void>
  startTimeoutMs?: number
}
export interface Launched { wsUrl: string; kill(): void }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const defaultRead = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null)
// Filtered env (sec-208-7): the browser and anything it launches never inherit the server's secrets.
const defaultSpawn = (bin: string, args: string[]): ChildLike => nodeSpawn(bin, args, { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] })

/** Jalankan Chromium (headful offscreen, atau headless bila `headless`) dan tunggu `DevToolsActivePort`; `onExit` dipanggil saat proses mati. */
export async function launchChromium(
  o: { bin: string; profileDir: string; proxyServer: string; headless?: boolean; onExit?: () => void },
  deps: LaunchDeps = {},
): Promise<Launched> {
  const read = deps.readFile ?? defaultRead
  const sleep = deps.sleep ?? defaultSleep
  mkdirSync(o.profileDir, { recursive: true, mode: PROFILE_DIR_MODE })
  const portFile = join(o.profileDir, ACTIVE_PORT_FILE)
  rmSync(portFile, { force: true }) // berkas basi dari proses lama menipu pembacaan port
  const child = (deps.spawn ?? defaultSpawn)(o.bin, buildChromiumArgs({ profileDir: o.profileDir, proxyServer: o.proxyServer, headless: o.headless }))
  let exited = false
  let spawnError: Error | null = null
  let stderrTail = ''
  child.stderr?.on('data', (b) => { stderrTail = (stderrTail + b.toString()).slice(-STDERR_TAIL_CHARS) })
  child.once('exit', () => { exited = true; o.onExit?.() })
  child.once('error', (e: Error) => { spawnError = e; exited = true })
  const kill = () => {
    child.kill('SIGTERM')
    const t = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    t.unref()
    child.once('exit', () => clearTimeout(t))
  }
  const deadline = Date.now() + (deps.startTimeoutMs ?? START_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (exited) {
      // stderr hanya dicocokkan, tidak pernah di-log mentah (bisa memuat path/URL).
      const sandbox = /sandbox/i.test(stderrTail)
      const holder = sandbox ? null : lockHolder(o.profileDir, deps)
      if (holder !== null && holder !== child.pid) {
        throw new LaunchError('profile_locked', `Chromium profile is still locked by another process (pid ${holder})`, spawnError ?? undefined)
      }
      throw new LaunchError(sandbox ? 'sandbox_unavailable' : 'launch_failed',
        sandbox ? 'browser_sandbox_unavailable: Chromium sandbox cannot start (no automatic --no-sandbox)' : 'Chromium exited before DevTools was ready',
        spawnError ?? undefined, spawnError ? 'spawn_error' : undefined)
    }
    const raw = read(portFile)
    const [port, path] = raw ? raw.split('\n') : []
    if (port && path && /^\d+$/.test(port.trim())) {
      return { wsUrl: `ws://${CDP_LOOPBACK}:${port.trim()}${path.trim()}`, kill }
    }
    await sleep(POLL_MS)
  }
  kill()
  throw new LaunchError('launch_failed', `Chromium did not publish ${ACTIVE_PORT_FILE} within the start timeout`, undefined, 'debug_port_timeout')
}

/** Antarmuka peluncur yang dipakai `BrowserHost`: URL debugger browser untuk satu profil (kunci = profileId). */
export interface BrowserLauncher {
  acquire(profileId: string): Promise<string>
  shutdown(): void
  /** A Chromium process runs (or is starting) on this profile. Absent in test fakes = treated as not live. */
  isLive?(profileId: string): boolean
  /** Kill the process of one profile (its session stays on disk). */
  stop?(profileId: string): void
}

/** Satu proses Chromium per profil; dibuat ulang bila mati; `shutdown()` membunuh semuanya. */
export function createChromiumPool(cfg: {
  env: Record<string, string | undefined>
  dataRoot: string
  proxyServer: () => string
  deps?: LaunchDeps
  exists?: (p: string) => boolean
  platform?: NodeJS.Platform
}): BrowserLauncher {
  const live = new Map<string, Promise<Launched>>()
  return {
    acquire(profileId) {
      let p = live.get(profileId)
      if (!p) {
        p = (async () => {
          const bin = resolveBinary(cfg.env, cfg.exists)
          const headless = headlessReason(cfg.env, cfg.platform)
          if (headless) log.warn('browser.headless', 'Chromium runs headless; sites detect it as a bot more easily', { reason: headless, ids: { profileId } })
          const profileDir = profileDirFor(cfg.dataRoot, profileId)
          // Not in `live` = no Chromium of this pool owns the profile; a holder is a leftover of an earlier run.
          const reclaimed = await reclaimProfile(profileDir, KILL_GRACE_MS, cfg.deps?.sleep ?? defaultSleep, cfg.deps)
          if (reclaimed !== null) log.warn('browser.profile_reclaimed', 'reclaimed the profile from a stale Chromium', { ids: { profileId }, pid: reclaimed })
          return launchChromium({
            bin, profileDir, proxyServer: cfg.proxyServer(), headless: headless !== null,
            onExit: () => { if (live.get(profileId) === p) live.delete(profileId); log.info('browser.exit', 'chromium exited', { ids: { profileId } }) },
          }, cfg.deps)
        })()
        live.set(profileId, p)
        p.catch(() => live.delete(profileId)) // lemparan tetap sampai ke pemanggil acquire
      }
      return p.then((l) => l.wsUrl)
    },
    isLive: (profileId) => live.has(profileId),
    stop(profileId) {
      const p = live.get(profileId)
      live.delete(profileId)
      p?.then((l) => l.kill(), () => undefined) // gagal-launch sudah dilaporkan ke pemanggil acquire
    },
    shutdown() {
      for (const p of live.values()) p.then((l) => l.kill(), () => undefined) // gagal-launch sudah dilaporkan ke pemanggil acquire
      live.clear()
    },
  }
}
