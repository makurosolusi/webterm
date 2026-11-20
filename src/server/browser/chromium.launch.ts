// Cari biner Chromium (hanya milik webterm sendiri) dan jalankan satu proses per profil. Tidak pernah dipanggil test
// dengan biner nyata: `spawn`, `exists`, `readFile`, `sleep` diinjeksi.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import type { LaunchReason } from '../../shared/browser.contract'
import { buildChromiumArgs, CDP_LOOPBACK, headlessReason, profileDirFor } from './chromium.flags'
import { createLogger } from '../logs'
import { childEnv } from '../childEnv'
import { ensureManaged, managedBinaryPath, managedRoot } from './chromium.managed'
import { clearForeignLock, lockHolder, reclaimProfile } from './chromium.profileLock'
import type { ProfileLockDeps } from './chromium.profileLock'

const log = createLogger('browser.launch')
export const START_TIMEOUT_MS = 20_000
export const POLL_MS = 100
export const KILL_GRACE_MS = 3_000
const STDERR_TAIL_CHARS = 4_096
const PROFILE_DIR_MODE = 0o700
const ACTIVE_PORT_FILE = 'DevToolsActivePort'

/** Data dir as config.ts `dataDir()` derives it, from an env snapshot (pure: tests pass their own); null without either var. */
export const dataDirOf = (env: Record<string, string | undefined>): string | null =>
  env.WEBTERM_DATA_DIR || (env.HOME ? join(env.HOME, '.webterm-server') : null)

/** Managed binary path for this env's data dir (may not exist yet); null on an unsupported platform or without a data dir. */
export function managedPathOf(env: Record<string, string | undefined>): string | null {
  const data = dataDirOf(env)
  return data ? managedBinaryPath(managedRoot(data)) : null
}

/** Chromium binaries that exist: only webterm's own managed build. Installed Chrome/Brave/Edge are never auto-picked (canvas-containment.md). */
export function chromiumCandidates(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string[] {
  const managed = managedPathOf(env)
  return managed && exists(managed) ? [managed] : []
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

/** Path biner: override eksplisit (harus ada; TIDAK jatuh ke otomatis) -> biner terkelola yang sudah ada -> `LaunchError('no_binary')`. */
export function resolveBinary(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string {
  const explicit = env[ENV_BROWSER.bin]?.trim()
  if (explicit) {
    if (!exists(explicit)) throw new LaunchError('no_binary', `${ENV_BROWSER.bin} points to a missing file`)
    return explicit
  }
  const found = chromiumCandidates(env, exists)[0]
  if (!found) throw new LaunchError('no_binary', 'managed Chrome for Testing is not downloaded yet')
  return found
}

/**
 * Deteksi biner tanpa melempar: override menang (harus ada); lalu biner terkelola. Bila belum diunduh tetapi platform didukung,
 * jalur tujuannya dilaporkan (diunduh otomatis saat peluncuran pertama); null = tidak ada jalan ke browser.
 */
export function detectChromium(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
): { path: string; source: 'override' | 'auto' } | null {
  if (env[ENV_BROWSER.bin]?.trim()) {
    return exists(env[ENV_BROWSER.bin]!.trim()) ? { path: env[ENV_BROWSER.bin]!.trim(), source: 'override' } : null
  }
  const path = managedPathOf(env)
  return path ? { path, source: 'auto' } : null
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

/** Explicit/managed binary, else a one-time automatic download of the managed build (info log, not an error). */
async function resolveOrInstall(cfg: { env: Record<string, string | undefined>; dataRoot: string; exists?: (p: string) => boolean; install?: (root: string) => Promise<string> }): Promise<string> {
  try {
    return resolveBinary(cfg.env, cfg.exists)
  } catch (e) {
    if (!(e instanceof LaunchError) || e.code !== 'no_binary' || cfg.env[ENV_BROWSER.bin]?.trim()) throw e
    log.info('browser.managed_missing', 'Managed Chrome for Testing missing; downloading it once')
    try {
      return await (cfg.install ?? ensureManaged)(managedRoot(cfg.dataRoot))
    } catch (err) {
      throw new LaunchError('no_binary', `could not download the managed Chrome for Testing: ${err instanceof Error ? err.message : 'unknown error'}`, err)
    }
  }
}

/** Satu proses Chromium per profil; dibuat ulang bila mati; `shutdown()` membunuh semuanya. */
export function createChromiumPool(cfg: {
  env: Record<string, string | undefined>
  dataRoot: string
  proxyServer: () => string
  deps?: LaunchDeps
  exists?: (p: string) => boolean
  platform?: NodeJS.Platform
  /** Seam: downloads the managed build into `<dataRoot>/browser/chrome-for-testing`; returns its binary. */
  install?: (root: string) => Promise<string>
}): BrowserLauncher {
  const live = new Map<string, Promise<Launched>>()
  return {
    acquire(profileId) {
      let p = live.get(profileId)
      if (!p) {
        p = (async () => {
          const bin = await resolveOrInstall(cfg)
          const headless = headlessReason(cfg.env, cfg.platform)
          if (headless) log.warn('browser.headless', 'Chromium runs headless; sites detect it as a bot more easily', { reason: headless, ids: { profileId } })
          const profileDir = profileDirFor(cfg.dataRoot, profileId)
          if (clearForeignLock(profileDir, cfg.deps)) log.info('browser.profile_lock_cleared', 'cleared a profile lock left by another host', { ids: { profileId }, reason: 'foreign_host' })
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
