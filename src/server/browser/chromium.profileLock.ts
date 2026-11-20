// Chromium profile lock: a Chromium left behind by an earlier server run (e.g. a forced exit that skipped
// shutdown) keeps `<profileDir>/SingletonLock`; every new launch for that profile then hands off to it and exits.
// Here we find that owner and reclaim the profile, but only when its command line proves it is our Chromium
// for this exact profile. Every process probe is injectable so tests never touch a real process.
import { execFile } from 'node:child_process'
import { readlinkSync, unlinkSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { childEnv } from '../childEnv'
import { isProcessAlive } from '../instanceFile'

export const SINGLETON_LOCK = 'SingletonLock'
const PROBE_POLL_MS = 100

export interface ProfileLockDeps {
  /** Target of the `SingletonLock` symlink (`<hostname>-<pid>`), null when there is none. */
  readLock?: (lockPath: string) => string | null
  /** Full command line of `pid`, null when it is gone. */
  commandOf?: (pid: number) => Promise<string | null>
  alive?: (pid: number) => boolean
  signal?: (pid: number, sig: NodeJS.Signals) => void
  /** This machine's hostname (what Chromium writes into the lock target). */
  hostname?: () => string
  /** Removes one file (not a directory); a missing file is not an error. */
  unlink?: (path: string) => void
}

const defaultReadLock = (lockPath: string): string | null => {
  try {
    return readlinkSync(lockPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EINVAL') return null // no lock, or not a symlink (not Chromium's format)
    throw new Error(`cannot read Chromium profile lock ${lockPath}`, { cause: err })
  }
}

const run = promisify(execFile)
const defaultCommandOf = async (pid: number): Promise<string | null> => {
  try {
    return (await run('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: childEnv() })).stdout.trim() || null
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return null // ps exits 1 when the pid no longer exists
    throw new Error(`cannot read the command line of pid ${pid}`, { cause: err })
  }
}

const defaultSignal = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return // exited between the probe and the signal: already reclaimed
    throw new Error(`cannot send ${sig} to pid ${pid}`, { cause: err })
  }
}

/** Pid of the process holding the profile lock while it is alive; null when unlocked or the holder is dead. */
export function lockHolder(profileDir: string, deps: ProfileLockDeps = {}): number | null {
  const target = (deps.readLock ?? defaultReadLock)(join(profileDir, SINGLETON_LOCK))
  const m = target ? /-(\d+)$/.exec(target) : null
  const pid = m ? Number(m[1]) : null
  return pid && (deps.alive ?? isProcessAlive)(pid) ? pid : null
}

/** The three files Chromium leaves in a profile dir to claim it; nothing else is ever removed here. */
const LOCK_FILES = [SINGLETON_LOCK, 'SingletonSocket', 'SingletonCookie'] as const

const defaultUnlink = (path: string): void => {
  try {
    unlinkSync(path) // on a symlink this removes the link itself, never its target
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`cannot remove stale Chromium profile lock file ${path}`, { cause: err })
  }
}

/**
 * Removes a lock left by ANOTHER host (target `<hostname>-<pid>` with a hostname other than ours). Chromium on Linux
 * treats such a lock as "profile in use by another computer" and exits at once; headless it cannot ask. This happens
 * when a container is recreated on the same /data volume (new hostname). Safe because a data dir is served by exactly
 * one server at a time (instanceFile.ts), so a foreign-host lock is a leftover, never a live owner of ours.
 * Same-host locks are untouched: a live one is reclaimProfile's job, a dead pid is handled by Chromium itself.
 * Returns true when the lock files were removed.
 */
export function clearForeignLock(profileDir: string, deps: ProfileLockDeps = {}): boolean {
  const target = (deps.readLock ?? defaultReadLock)(join(profileDir, SINGLETON_LOCK))
  const m = target ? /^(.+)-\d+$/.exec(target) : null
  if (!m || m[1] === (deps.hostname ?? osHostname)()) return false
  const unlink = deps.unlink ?? defaultUnlink
  // Fixed basenames joined onto profileDir: nothing outside the profile dir can be named.
  for (const f of LOCK_FILES) unlink(join(profileDir, f))
  return true
}

/** True when `command` carries `--user-data-dir=<profileDir>` exactly (not a longer sibling path). */
export function ownsProfile(command: string, profileDir: string): boolean {
  const flag = `--user-data-dir=${profileDir}`
  const i = command.indexOf(flag)
  const end = i + flag.length
  return i >= 0 && (end === command.length || command[end] === ' ')
}

/**
 * If a live Chromium for exactly this profile holds its lock, SIGTERM it, SIGKILL after `graceMs`, and wait for it
 * to exit. Returns the reclaimed pid, or null when nothing was killed (no lock, dead holder, or not ours).
 */
export async function reclaimProfile(
  profileDir: string, graceMs: number, sleep: (ms: number) => Promise<void>, deps: ProfileLockDeps = {},
): Promise<number | null> {
  const pid = lockHolder(profileDir, deps)
  if (pid === null || pid === process.pid) return null
  const command = await (deps.commandOf ?? defaultCommandOf)(pid)
  if (!command || !ownsProfile(command, profileDir)) return null
  const alive = deps.alive ?? isProcessAlive
  const signal = deps.signal ?? defaultSignal
  const exited = async (): Promise<boolean> => {
    for (let waited = 0; waited < graceMs; waited += PROBE_POLL_MS) {
      if (!alive(pid)) return true
      await sleep(PROBE_POLL_MS)
    }
    return !alive(pid)
  }
  signal(pid, 'SIGTERM')
  if (!(await exited())) {
    signal(pid, 'SIGKILL')
    await exited()
  }
  return pid
}
