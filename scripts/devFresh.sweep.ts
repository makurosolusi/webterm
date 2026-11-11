// Leftovers of `dev:fresh` runs that did not exit through Ctrl+C (script SIGKILLed, crash, terminal
// closed): the server and its Chromium, the fresh tmux server, the Claude keychain items and the temp
// root. Every run records `owner.json`; a root whose owner is dead is stopped and removed here.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { supervisorSocket } from '../src/server/ptySupervisor'
import { findOnPath } from '../src/server/binaryOnPath'

/** Temp root basename prefix; cleanup refuses any directory without it. */
export const ROOT_PREFIX = 'webterm-fresh-'
/** Server argv marker: lets the sweep prove a process belongs to a root (macOS `ps` cannot show env). */
export const ROOT_ARG = '--webterm-fresh-root='
export const OWNER_FILE = 'owner.json'
/** A root without owner.json (older dev:fresh, or a run that died before writing it) is stale after this. */
export const NO_OWNER_STALE_MS = 60 * 60 * 1000
const STOP_GRACE_MS = 5000
const POLL_MS = 100
/** `security` exit status for "item not found". */
const KEYCHAIN_NOT_FOUND = 44

export interface FreshOwner { pid: number; childPid: number; pgid: number; tmuxSocket: string; claudeConfigDir: string; createdAt: string; keep: boolean }

/** Throw unless `root` is a `webterm-fresh-*` dir directly inside `tmpBase` (both resolved through symlinks). */
export function assertFreshRoot(root: string, tmpBase: string = tmpdir()): void {
  const base = realpathSync(tmpBase)
  const dir = resolve(root)
  const real = join(realpathSync(dirname(dir)), basename(dir))
  if (dirname(real) !== base || !basename(real).startsWith(ROOT_PREFIX)) {
    throw new Error(`refusing to delete ${root}: not a ${ROOT_PREFIX}* directory directly inside ${base}`)
  }
}

/** Delete a temp root; anything that is not one throws. */
export function removeFreshRoot(root: string, tmpBase: string = tmpdir()): void {
  assertFreshRoot(root, tmpBase)
  rmSync(root, { recursive: true, force: true })
}

export function writeOwner(root: string, o: FreshOwner): void {
  writeFileSync(join(root, OWNER_FILE), JSON.stringify(o), { mode: 0o600 })
}

/** owner.json contents, or null when missing fields/garbled (then the root is judged by age). */
export function parseOwner(text: string): FreshOwner | null {
  try {
    const o = JSON.parse(text) as Partial<FreshOwner>
    const int = (n: unknown) => Number.isInteger(n) && (n as number) > 1
    if (!int(o.pid) || !int(o.childPid) || !int(o.pgid) || typeof o.tmuxSocket !== 'string' || typeof o.claudeConfigDir !== 'string' || typeof o.createdAt !== 'string') return null
    return { ...(o as FreshOwner), keep: o.keep === true }
  } catch { return null } // not JSON: same as no owner file
}

/** Why a root is stale, or null when it must be left alone. Pure. */
export function staleReason(i: { owner: FreshOwner | null; ownerAlive: boolean; ageMs: number }): 'owner_dead' | 'no_owner' | null {
  if (i.owner) return i.ownerAlive ? null : 'owner_dead'
  return i.ageMs > NO_OWNER_STALE_MS ? 'no_owner' : null
}

/** Account Claude Code files its keychain items under (its own `$USER` rule). */
export function claudeKeychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  let u: string
  try { u = env.USER || userInfo().username } catch { u = 'claude-code-user' } // same fallback as Claude Code
  return /^[a-zA-Z0-9._-]+$/.test(u) ? u : 'claude-code-user'
}

/**
 * Keychain services Claude Code uses for one CLAUDE_CONFIG_DIR (OAuth sign-in, `/login` API key),
 * matching claude 2.1.322: `Claude Code${suffix}-${sha256(NFC dir).hex[0..8]}`.
 */
export function claudeKeychainServices(claudeConfigDir: string): string[] {
  const h = createHash('sha256').update(claudeConfigDir.normalize('NFC')).digest('hex').slice(0, 8)
  return [`Claude Code-credentials-${h}`, `Claude Code-${h}`]
}

export type KeychainRunner = (args: string[]) => { status: number | null; stderr: string }
// Resolved on PATH (macOS: /usr/bin/security) so subprocess tests can put a recording fake first.
const securityCli: KeychainRunner = (args) => {
  const r = spawnSync('security', args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }) // stdout (item attributes) never read
  return { status: r.status, stderr: r.error ? r.error.message : r.stderr }
}

/** Delete this config dir's Claude keychain items by exact service name (macOS only); never reads a secret. */
export function deleteClaudeKeychain(claudeConfigDir: string, run: KeychainRunner = securityCli, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') return
  for (const service of claudeKeychainServices(claudeConfigDir)) {
    const r = run(['delete-generic-password', '-a', claudeKeychainAccount(), '-s', service])
    if (r.status !== 0 && r.status !== KEYCHAIN_NOT_FOUND) {
      process.stderr.write(`dev:fresh: keychain delete of "${service}" failed (status ${r.status}): ${r.stderr.trim().split('\n')[0] ?? ''}\n`)
    }
  }
}

/** End a fresh tmux server (socket derived from ITS data dir, never `webterm`). No server = no-op. */
export function killTmuxServer(dataDir: string, pathEnv?: string): void {
  const tmux = (pathEnv && findOnPath('tmux', pathEnv)) || findOnPath('tmux')
  if (!tmux) return
  const r = spawnSync(tmux, ['-L', supervisorSocket(dataDir), 'kill-server'], { stdio: 'ignore' })
  if (r.error) process.stderr.write(`dev:fresh: tmux kill-server for ${dataDir} failed (${r.error.message})\n`)
}

export interface Proc { pid: number; pgid: number; command: string }

export function listProcs(): Proc[] {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ps failed (status ${r.status}): ${r.error?.message ?? r.stderr}`)
  return r.stdout.split('\n').flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l)
    return m ? [{ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }] : []
  })
}

/**
 * Processes of `root`: those whose argv names it (server marker, Chromium `--user-data-dir`), plus the
 * rest of the recorded process group when a member of that group proved it is this root's. Pure.
 */
export function rootProcesses(procs: readonly Proc[], root: string, pgid?: number, self: number = process.pid): number[] {
  const marker = `${ROOT_ARG}${root}`
  const own = (p: Proc) => p.command.endsWith(marker) || p.command.includes(`${marker} `) || p.command.includes(`--user-data-dir=${root}/`)
  const proven = procs.filter(own)
  const groupOk = pgid !== undefined && proven.some((p) => p.pgid === pgid)
  return [...new Set([...proven, ...procs.filter((p) => groupOk && p.pgid === pgid)].map((p) => p.pid))].filter((p) => p !== self)
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
const send = (pid: number, sig: NodeJS.Signals) => {
  try { process.kill(pid, sig) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`cannot send ${sig} to ${pid}`, { cause: e })
  }
}
async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const until = Date.now() + ms
  let left = pids.filter(alive)
  while (left.length && Date.now() < until) { await new Promise((r) => setTimeout(r, POLL_MS)); left = left.filter(alive) }
  return left
}

/** SIGTERM, then SIGKILL whatever is left after the grace period; resolves once all are gone. */
export async function stopPids(pids: number[], graceMs = STOP_GRACE_MS): Promise<void> {
  for (const p of pids) send(p, 'SIGTERM')
  const left = await waitGone(pids, graceMs)
  for (const p of left) send(p, 'SIGKILL')
  const stuck = await waitGone(left, 2000)
  if (stuck.length) throw new Error(`processes ${stuck.join(',')} survived SIGKILL`)
}

/** Ownership-proven processes, tmux server, keychain items, then (unless kept) the root itself. */
export async function cleanRoot(root: string, o: { tmpBase: string; owner: FreshOwner | null; remove: boolean; keychain?: KeychainRunner; procs?: Proc[] }): Promise<void> {
  assertFreshRoot(root, o.tmpBase)
  await stopPids(rootProcesses(o.procs ?? listProcs(), root, o.owner?.pgid))
  killTmuxServer(join(root, 'data'))
  deleteClaudeKeychain(o.owner?.claudeConfigDir ?? join(root, 'claude'), o.keychain)
  if (o.remove) removeFreshRoot(root, o.tmpBase)
}

/** ms since the root was made: the timestamp in its name, else its mtime. */
function rootAgeMs(root: string, now: number): number {
  const ts = Number(/^webterm-fresh-(\d+)-/.exec(basename(root))?.[1])
  return now - (Number.isFinite(ts) ? ts : statSync(root).mtimeMs)
}

export interface SweepResult { cleaned: string[]; live: Array<{ root: string; pid: number }>; kept: string[]; failed: string[] }

/**
 * Clean every stale `webterm-fresh-*` root in `tmpBase`. Live roots are never touched; a `--keep`
 * root gets its processes, tmux and keychain items cleaned but its files stay (the user asked).
 */
export async function sweepStale(o: { tmpBase?: string; keychain?: KeychainRunner; now?: number } = {}): Promise<SweepResult> {
  const base = realpathSync(o.tmpBase ?? tmpdir())
  const res: SweepResult = { cleaned: [], live: [], kept: [], failed: [] }
  const roots = readdirSync(base).filter((n) => n.startsWith(ROOT_PREFIX)).map((n) => join(base, n))
  if (!roots.length) return res
  const procs = listProcs()
  for (const root of roots) {
    try {
      const f = join(root, OWNER_FILE)
      const owner = existsSync(f) ? parseOwner(readFileSync(f, 'utf8')) : null
      // pid alone is not enough (reuse): the owner must still be a dev:fresh script.
      const ownerAlive = !!owner && procs.some((p) => p.pid === owner.pid && p.command.includes('devFresh'))
      const reason = staleReason({ owner, ownerAlive, ageMs: rootAgeMs(root, o.now ?? Date.now()) })
      if (!reason) { if (owner) res.live.push({ root, pid: owner.pid }); continue }
      const remove = !owner?.keep
      await cleanRoot(root, { tmpBase: base, owner, remove, keychain: o.keychain, procs })
      ;(remove ? res.cleaned : res.kept).push(root)
    } catch (e) {
      res.failed.push(root)
      process.stderr.write(`dev:fresh: cleaning ${root} failed: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  return res
}
