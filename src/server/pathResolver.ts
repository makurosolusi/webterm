// Central PATH resolver: a tool installed AFTER the server booted (envman, op, a user's own app) must be
// callable without registering it. The login-shell PATH is merged once at boot (loginShellPath.ts), so a
// miss is not trusted: before concluding "missing" we rescan the usual tool dirs and the user's extra
// dirs synchronously (cheap stats), and ask the login shell again in the background. Misses are rate
// limited per name so a typo does not hammer the disk or spawn shells.
import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { inspectBinary } from './binaryFormat'
import { findOnPath } from './binaryOnPath'
import { customBinPath, getExtraPathDirs, setExtraPathDirs, withCustomBin } from './customBinPath'

export const REFRESH_INTERVAL_MS = 15_000
/** Directories where people usually install CLIs, scanned on a miss (only the ones that exist and are safe). */
export const commonToolDirs = (home: string = process.env.HOME || homedir()): string[] => [
  join(home, '.local/bin'), join(home, 'bin'), join(home, 'go/bin'), join(home, '.cargo/bin'), join(home, '.bun/bin'), join(home, '.deno/bin'),
  '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/opt/custom/bin',
]

export interface PathResolverDeps {
  /** Login-shell PATH, asynchronously (never blocks the event loop). */
  loginPath?: () => Promise<string | undefined>
  /** The user's extra dirs from the sidecar; re-read on every refresh so CLI edits reach a running server. */
  loadExtras?: () => string[]
}
let deps: PathResolverDeps = {}
export const configurePathResolver = (d: PathResolverDeps): void => { deps = d }

const lastMiss = new Map<string, number>()
let inflight: Promise<number> | undefined

/** An existing directory that is not world-writable (anyone could plant a binary in one that is). */
export function isSafeToolDir(dir: string): boolean {
  try {
    const st = statSync(dir)
    return st.isDirectory() && (st.mode & 0o002) === 0
  } catch {
    return false // missing or unreadable: not a usable tool dir
  }
}

const hasEntry = (path: string, dir: string): boolean => path.split(delimiter).includes(dir)

/** Applies sidecar extras, then appends the safe existing common dirs missing from `env.PATH`. Returns how many were added. */
export function scanToolDirs(env: NodeJS.ProcessEnv = process.env): number {
  const previous = getExtraPathDirs()
  if (deps.loadExtras) setExtraPathDirs(deps.loadExtras().filter(isSafeToolDir))
  const dropped = previous.filter((d) => !getExtraPathDirs().includes(d)) // removed by the user since the last scan
  const before = (env.PATH ?? '').split(delimiter).filter((e) => !dropped.includes(e)).join(delimiter)
  const added = commonToolDirs(env.HOME).filter((d) => !hasEntry(before, d) && isSafeToolDir(d))
  env.PATH = withCustomBin([...before.split(delimiter), ...added].join(delimiter), customBinPath(env))
  return added.length
}

/** Merges the login shell's PATH entries that this process lacks (append only). Returns how many were added. */
async function refreshFromLoginShell(env: NodeJS.ProcessEnv): Promise<number> {
  if (!deps.loginPath) return 0
  inflight ??= deps.loginPath().then((login) => {
    const have = env.PATH ?? ''
    const extra = (login ?? '').split(delimiter).filter((e) => e && !hasEntry(have, e))
    if (extra.length) env.PATH = [have, ...extra].filter(Boolean).join(delimiter)
    return extra.length
  }).catch(() => 0).finally(() => { inflight = undefined }) // a failing login shell just adds nothing; the sync scan already ran
  return inflight
}

/** On a miss of `name`: rescan (rate limited, once per name per interval). True when PATH changed and a retry is worthwhile. */
export function refreshOnMiss(name: string, now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const last = lastMiss.get(name)
  if (last !== undefined && now - last < REFRESH_INTERVAL_MS) return false
  lastMiss.set(name, now)
  const before = env.PATH
  scanToolDirs(env)
  if (!findOnPath(name, env.PATH ?? '')) probeHomeBinDirs(name, env)
  void refreshFromLoginShell(env) // background: helps the NEXT lookup of tools that only the login shell's rc files expose
  return env.PATH !== before
}

/** Forced refresh (Settings "Rescan", `webterm command rescan`): clears the miss cache and awaits the login shell. */
export async function rescan(env: NodeJS.ProcessEnv = process.env): Promise<{ added: number }> {
  lastMiss.clear()
  const added = scanToolDirs(env) + (await refreshFromLoginShell(env))
  return { added }
}

export const resetPathResolverForTest = (): void => { lastMiss.clear(); inflight = undefined; deps = {}; setExtraPathDirs([]); found.length = 0 }

// Installer one-liners put a tool in ~/.local/bin or ~/.<tool>/bin and only edit rc files for NEW shells.
// On a miss, after the usual dirs, look one level under HOME (`~/.*/bin`, `~/{go,bin,opt}/bin`), bounded.
const HOME_PROBE_MAX_DIRS = 64
const HOME_PROBE_BUDGET_MS = 200
const HOME_PLAIN_DIRS = ['go', 'bin', 'opt']
/** Tools located by the home probe: in PATH for this server run only, never persisted without the user's say. */
const found: { name: string; dir: string }[] = []
const pendingNotices: string[] = []
export const sessionFoundDirs = (): readonly { name: string; dir: string }[] => found
/** Notices not yet shown to the user (each is returned once). */
export const takeFoundNotices = (): string[] => pendingNotices.splice(0)

const tilde = (p: string, home: string): string => (p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p)

/** Non-symlink directory whose real path stays inside `home` (a link out of HOME is not followed). */
function insideHome(dir: string, realHome: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false
    const real = realpathSync(dir)
    return real === realHome || real.startsWith(realHome + sep)
  } catch {
    return false // vanished or unreadable
  }
}

/** Adds `<home>/<x>/bin` holding an executable `name` of a fitting platform to this process's PATH. True when one was found. */
export function probeHomeBinDirs(name: string, env: NodeJS.ProcessEnv = process.env, budgetMs: number = HOME_PROBE_BUDGET_MS): boolean {
  const home = env.HOME || homedir()
  const start = Date.now()
  let realHome: string
  let names: string[]
  try { realHome = realpathSync(home); names = readdirSync(home) } catch { return false }
  const cands = [...names.filter((n) => n.startsWith('.') && n.length > 1).sort(), ...HOME_PLAIN_DIRS.filter((n) => names.includes(n))]
  let checked = 0
  for (const n of cands) {
    if (checked >= HOME_PROBE_MAX_DIRS || Date.now() - start > budgetMs) return false
    const dir = join(home, n, 'bin')
    if (hasEntry(env.PATH ?? '', dir)) continue
    checked++
    if (!insideHome(join(home, n), realHome) || !insideHome(dir, realHome) || !isSafeToolDir(dir)) continue
    const file = join(dir, name)
    if (!isExecutableFile(file) || ['wrong_platform', 'wrong_arch'].includes(inspectBinary(name, file).compat)) continue
    env.PATH = [env.PATH ?? '', dir].filter(Boolean).join(delimiter)
    if (pendingNotices.length < 20) pendingNotices.push(`${name} was found in ${tilde(dir, home)} and added to PATH for this session. Add it permanently: webterm command path add ${tilde(dir, home)}`)
    found.push({ name, dir })
    return true
  }
  return false
}

/** Absolute path of `name` on the process PATH, refreshing once on a miss. */
export function resolveBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const hit = findOnPath(name, env.PATH ?? '')
  if (hit || name.includes('/')) return hit
  return refreshOnMiss(name, Date.now(), env) ? findOnPath(name, env.PATH ?? '') : undefined
}

/** Why `bin` (found on PATH) must not be launched on this machine, or null: a binary built for another OS/arch. Reads the header only. */
export function incompatReasonFor(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = bin.includes('/') ? bin : findOnPath(bin, env.PATH ?? '')
  return path ? inspectBinary(bin, path).message : null
}

/** True when `p` is an executable regular file; shared with the store. */
export function isExecutableFile(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false }
}
