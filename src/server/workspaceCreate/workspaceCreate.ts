// Folder side of "Clone repository" and "New project". The workspace row itself is made by the
// client through the existing POST /api/workspaces once a path comes back.
//
// Clone copies nodeterm core/git-service.ts clone(): single flight, `git clone --progress -- url
// path`, progress parsed from stderr, abort, and on failure/abort delete ONLY the directory this
// run created. New project copies Orca's repos:create: safe name, absolute parent (made if
// missing), refuse a non-empty target, `git init` + an empty "Initial commit", undo on failure.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DATA_DIR_MESSAGE, insideDataDir } from './projectsFolder'
import { gitCommand } from '../gitExec'
import { promisify } from 'node:util'
import { cloneErrorMessage, deriveRepoDirName, expandCloneUrl, isSafeFolderName, isValidCloneUrl, parseCloneProgress, type CloneProgress } from './cloneUrl'

const run = promisify(execFile)

export type CreateErrorCode = 'bad_request' | 'exists' | 'busy' | 'git_failed' | 'aborted'
export class CreateError extends Error {
  constructor(readonly code: CreateErrorCode, message: string) { super(message) }
}

export interface CreateDeps {
  /** git binary; tests point it at a fake script. */
  git?: string
  /** webterm data dir; tests inject a temp dir. Default: config `dataDir()`. */
  dataDir?: string
  /** Bound on how long a cancel waits for the clone's pipes to close; tests shorten it. */
  abortMaxMs?: number
}

/** gitExec.ts argv/env (filtered env, no prompt); the user's own clone/new project keeps hooks. */
const userGit = (args: string[], deps: CreateDeps) => {
  const g = gitCommand(args, { userHooks: true })
  return { file: deps.git ?? g.file, args: g.args, env: g.env }
}

/** Final guard behind the dialog's blocking warning: nothing is ever created inside the data dir. */
async function refuseDataDir(target: string, deps: CreateDeps): Promise<void> {
  const dataDir = deps.dataDir ?? (await import('../config')).dataDir()
  if (await insideDataDir(target, dataDir)) throw new CreateError('bad_request', DATA_DIR_MESSAGE)
}

/** `parent/name`, refused unless parent is absolute and the result stays strictly inside it (Orca gzr). */
export function resolveTarget(parent: string, name: string): string {
  if (!parent || !isAbsolute(parent)) throw new CreateError('bad_request', 'Parent folder must be an absolute path.')
  if (!isSafeFolderName(name)) throw new CreateError('bad_request', 'Folder name cannot be empty, contain slashes, or be "." / "..".')
  const target = resolve(parent, name)
  const rel = relative(resolve(parent), target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CreateError('bad_request', 'Folder must be inside the parent folder.')
  return target
}

/** Make the parent, then claim the target. true = this run created it (so it may delete it). */
async function claimTarget(parent: string, target: string): Promise<boolean> {
  await mkdir(parent, { recursive: true })
  try {
    await mkdir(target)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new CreateError('bad_request', `Cannot create ${target}: ${(e as Error).message}`)
  }
  const entries = await readdir(target).catch((e: Error) => { throw new CreateError('exists', `${target} exists and is not a folder: ${e.message}`) })
  if (entries.length > 0) throw new CreateError('exists', `"${target}" already exists and is not empty. Pick another name or open it directly.`)
  return false
}

/** Re-signal cadence while a cancel waits for `close`. */
const CLONE_RESIGNAL_MS = 100
/** SIGTERM phase of a cancel; after it the group gets SIGKILL. */
export const CLONE_KILL_GRACE_MS = 2_000
/** Give up waiting for `close` after this; the clone is reported cancelled and the slot freed. */
export const CLONE_ABORT_MAX_MS = 10_000

interface ActiveClone {
  child: ChildProcess | null
  aborted: boolean
  abortMaxMs: number
  /** Set once the kill loop runs; clears its timer. */
  stopKilling?: () => void
  /** Settles the clone when the kill loop runs past abortMaxMs. */
  giveUp?: () => void
}
let activeClone: ActiveClone | null = null

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal) } catch { child.kill(signal) } // group gone: signal the leader (never throws)
}

/**
 * One group SIGTERM is not enough: a child git/the shell forks at that instant misses it, stays in
 * the group and holds the stderr pipe, so `close` never fires. Keep re-signalling the group (SIGKILL
 * after the grace) until `close` stops the loop, or give up after abortMaxMs.
 */
function startKilling(rec: ActiveClone): void {
  const child = rec.child
  if (!child || rec.stopKilling) return
  const started = Date.now()
  killGroup(child, 'SIGTERM')
  const tick = setInterval(() => {
    const elapsed = Date.now() - started
    if (elapsed >= rec.abortMaxMs) { rec.giveUp?.(); return }
    killGroup(child, elapsed >= CLONE_KILL_GRACE_MS ? 'SIGKILL' : 'SIGTERM')
  }, CLONE_RESIGNAL_MS)
  rec.stopKilling = () => clearInterval(tick)
}

/** Kill the in-flight clone's process group (git plus its ssh/remote helpers). false when idle. */
export function abortClone(): boolean {
  if (!activeClone) return false
  activeClone.aborted = true
  startKilling(activeClone)
  return true
}

export interface CloneInput { url: string; parent: string; name?: string }

/** Clones and resolves the cloned path; rejects with CreateError. `onProgress` gets nodeterm's {phase, percent}. */
export async function cloneRepo(input: CloneInput, onProgress: (p: CloneProgress) => void, deps: CreateDeps = {}): Promise<string> {
  const url = expandCloneUrl(input.url ?? '')
  if (!isValidCloneUrl(url)) throw new CreateError('bad_request', 'Use an https:// or git@host:owner/repo URL, or owner/repo for GitHub.')
  const name = input.name?.trim() || deriveRepoDirName(url)
  if (!name) throw new CreateError('bad_request', 'Could not derive a folder name from that URL.')
  const target = resolveTarget(input.parent, name)
  await refuseDataDir(target, deps)
  if (activeClone) throw new CreateError('busy', 'A clone is already running.')
  // Reserve the slot before the first await so a second request cannot slip past the guard.
  const rec: ActiveClone = { child: null, aborted: false, abortMaxMs: deps.abortMaxMs ?? CLONE_ABORT_MAX_MS }
  activeClone = rec
  let created = false
  try {
    created = await claimTarget(input.parent, target)
    const { code, tail, stuck } = await new Promise<{ code: number | null; tail: string; stuck?: boolean }>((done) => {
      let settled = false
      let tail = ''
      const finish = (r: { code: number | null; tail: string; stuck?: boolean }) => {
        if (settled) return
        settled = true
        rec.stopKilling?.()
        rec.stopKilling = () => {} // a late abortClone must not start a loop nobody stops
        done(r)
      }
      // detached = own session, no controlling TTY: ssh cannot sit on a passphrase/host-key prompt.
      const g = userGit(['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', 'clone', '--progress', '--', url, target], deps)
      const child = spawn(g.file, g.args, { cwd: input.parent, env: g.env, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
      rec.child = child
      rec.giveUp = () => finish({ code: null, tail, stuck: true })
      if (rec.aborted) startKilling(rec)
      child.stderr?.on('data', (d: Buffer) => {
        if (settled) return
        const text = d.toString('utf8')
        tail = (tail + text).slice(-4096)
        const p = parseCloneProgress(text)
        if (p) onProgress(p)
      })
      child.on('error', (e) => finish({ code: -1, tail: `fatal: git could not start: ${e.message}` }))
      child.on('close', (c) => finish({ code: c, tail }))
    })
    if (stuck) throw new CreateError('aborted', `Clone cancelled, but git (process group ${rec.child?.pid}) did not exit within ${Math.round(rec.abortMaxMs / 1000)}s and may still be running.`)
    if (rec.aborted) throw new CreateError('aborted', 'Clone cancelled.')
    if (code !== 0) throw new CreateError('git_failed', cloneErrorMessage(tail))
    return target
  } catch (e) {
    if (created) await rm(target, { recursive: true, force: true })
    throw e
  } finally {
    activeClone = null
  }
}

export interface ProjectInput { parent: string; name: string; gitInit?: boolean }

/** mkdir parent/name, optionally `git init -b main` + empty initial commit; resolves the path. */
export async function createProject(input: ProjectInput, deps: CreateDeps = {}): Promise<string> {
  const target = resolveTarget(input.parent, (input.name ?? '').trim())
  await refuseDataDir(target, deps)
  const created = await claimTarget(input.parent, target)
  if (input.gitInit === false) return target
  const git = (args: string[]) => { const g = userGit(args, deps); return run(g.file, g.args, { cwd: target, env: g.env, timeout: 30_000 }) }
  let step: 'init' | 'commit' = 'init'
  try {
    await git(['init', '-b', 'main'])
    step = 'commit'
    await git(['commit', '--allow-empty', '-m', 'Initial commit'])
    return target
  } catch (e) {
    await rm(created ? target : join(target, '.git'), { recursive: true, force: true })
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message).trim()
    if (step === 'commit' && /please tell me who you are|user\.name|user\.email/i.test(msg)) {
      throw new CreateError('git_failed', 'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again, or untick "Initialize git".')
    }
    throw new CreateError('git_failed', `${step === 'init' ? 'Failed to initialize git repository' : 'Failed to create initial commit'}: ${msg}`)
  }
}
