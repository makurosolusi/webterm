// Cari biner Chromium dan jalankan satu proses per profil workspace. Tidak pernah dipanggil test
// dengan biner nyata: `spawn`, `exists`, `readFile`, `sleep` diinjeksi.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_BROWSER } from '../../shared/browser.contract'
import { buildChromiumArgs, CDP_LOOPBACK, profileDirFor } from './chromium.flags'
import { createLogger } from '../logs'

const log = createLogger('browser.launch')
export const START_TIMEOUT_MS = 20_000
export const POLL_MS = 100
export const KILL_GRACE_MS = 3_000
const STDERR_TAIL_CHARS = 4_096
const PROFILE_DIR_MODE = 0o700
const ACTIVE_PORT_FILE = 'DevToolsActivePort'

/** Lokasi umum macOS/Linux bila `WEBTERM_BROWSER_BIN` kosong. */
export const BIN_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
] as const

export class LaunchError extends Error {
  constructor(readonly code: 'no_binary' | 'sandbox_unavailable' | 'launch_failed', message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LaunchError'
  }
}

/** Path biner: env eksplisit (harus ada) -> lokasi umum -> `LaunchError('no_binary')`. */
export function resolveBinary(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string {
  const explicit = env[ENV_BROWSER.bin]?.trim()
  if (explicit) {
    if (!exists(explicit)) throw new LaunchError('no_binary', `${ENV_BROWSER.bin} points to a missing file`)
    return explicit
  }
  const found = BIN_CANDIDATES.find((p) => exists(p))
  if (!found) throw new LaunchError('no_binary', `no Chromium found; install one or set ${ENV_BROWSER.bin}`)
  return found
}

/** Bagian ChildProcess yang dipakai (memudahkan fake di test). */
export interface ChildLike {
  pid?: number
  stderr?: { on(ev: 'data', cb: (b: Buffer | string) => void): unknown } | null
  once(ev: 'exit' | 'error', cb: (...a: any[]) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  kill(sig?: NodeJS.Signals): boolean
}
export interface LaunchDeps {
  spawn?: (bin: string, args: string[]) => ChildLike
  readFile?: (path: string) => string | null
  sleep?: (ms: number) => Promise<void>
  startTimeoutMs?: number
}
export interface Launched { wsUrl: string; kill(): void }

const defaultRead = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const defaultSpawn = (bin: string, args: string[]): ChildLike => nodeSpawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

/** Jalankan Chromium headless dan tunggu `DevToolsActivePort`; `onExit` dipanggil saat proses mati. */
export async function launchChromium(
  o: { bin: string; profileDir: string; proxyServer: string; onExit?: () => void },
  deps: LaunchDeps = {},
): Promise<Launched> {
  const read = deps.readFile ?? defaultRead
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  mkdirSync(o.profileDir, { recursive: true, mode: PROFILE_DIR_MODE })
  const portFile = join(o.profileDir, ACTIVE_PORT_FILE)
  rmSync(portFile, { force: true }) // berkas basi dari proses lama menipu pembacaan port
  const child = (deps.spawn ?? defaultSpawn)(o.bin, buildChromiumArgs({ profileDir: o.profileDir, proxyServer: o.proxyServer }))
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
      throw new LaunchError(sandbox ? 'sandbox_unavailable' : 'launch_failed',
        sandbox ? 'browser_sandbox_unavailable: Chromium sandbox cannot start (no automatic --no-sandbox)' : 'Chromium exited before DevTools was ready',
        spawnError ?? undefined)
    }
    const raw = read(portFile)
    const [port, path] = raw ? raw.split('\n') : []
    if (port && path && /^\d+$/.test(port.trim())) {
      return { wsUrl: `ws://${CDP_LOOPBACK}:${port.trim()}${path.trim()}`, kill }
    }
    await sleep(POLL_MS)
  }
  kill()
  throw new LaunchError('launch_failed', `Chromium did not publish ${ACTIVE_PORT_FILE} within the start timeout`)
}

/** Antarmuka peluncur yang dipakai `BrowserHost`: URL debugger browser untuk satu workspace. */
export interface BrowserLauncher { acquire(workspaceId: string): Promise<string>; shutdown(): void }

/** Satu proses Chromium per profil workspace; dibuat ulang bila mati; `shutdown()` membunuh semuanya. */
export function createChromiumPool(cfg: {
  env: Record<string, string | undefined>
  dataRoot: string
  proxyServer: () => string
  deps?: LaunchDeps
  exists?: (p: string) => boolean
}): BrowserLauncher {
  const live = new Map<string, Promise<Launched>>()
  return {
    acquire(workspaceId) {
      let p = live.get(workspaceId)
      if (!p) {
        p = (async () => {
          const bin = resolveBinary(cfg.env, cfg.exists)
          return launchChromium({
            bin, profileDir: profileDirFor(cfg.dataRoot, workspaceId), proxyServer: cfg.proxyServer(),
            onExit: () => { live.delete(workspaceId); log.info('browser.exit', 'chromium exited', { ids: { workspaceId } }) },
          }, cfg.deps)
        })()
        live.set(workspaceId, p)
        p.catch(() => live.delete(workspaceId)) // lemparan tetap sampai ke pemanggil acquire
      }
      return p.then((l) => l.wsUrl)
    },
    shutdown() {
      for (const p of live.values()) p.then((l) => l.kill(), () => undefined) // gagal-launch sudah dilaporkan ke pemanggil acquire
      live.clear()
    },
  }
}
