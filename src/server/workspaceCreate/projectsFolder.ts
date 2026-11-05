// Where new projects go, and the "wrong place" checks run before a clone or a new project.
//
// Default projects folder = `~/webterm/projects`: visible, not a dot-dir, modelled on Orca's
// `~/orca/projects` (replaces nodeterm's `~/projects`-else-home). Nothing here creates it; the
// clone/new-project `mkdir -p` of the parent does, on first real use. It may never sit inside the
// webterm data dir: that folder holds the DB and tokens, and a project there would be wiped with it.
import { spawn as nodeSpawn } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DATA_DIR_MESSAGE = 'This is inside the webterm data folder, which holds its database. Pick another folder.'

export interface FolderEnv {
  home: string
  dataDir: string
  /** `Settings.defaultProjectsFolder` ('' = built-in default). */
  configured: string
}

/** Real env: HOME, the data dir and the stored setting, read lazily (db pulls in bun:sqlite). */
export async function folderEnv(): Promise<FolderEnv> {
  const [{ dataDir }, { db }] = await Promise.all([import('../config'), import('../db')])
  return { home: process.env.HOME || homedir(), dataDir: dataDir(), configured: db.getSettings().defaultProjectsFolder }
}

/** `~/webterm/projects`; `~/webterm-projects` in the odd setup where the data dir would contain it. */
export function builtinProjectsFolder(home: string, dataDir: string): string {
  const p = join(home, 'webterm', 'projects')
  // ponytail: one fallback; a data dir that also contains ~/webterm-projects (i.e. HOME itself) is not handled.
  return isInside(p, dataDir) ? join(home, 'webterm-projects') : p
}

/** true when `p` is `root` or below it (plain path comparison; see `realish` for symlinks). */
export function isInside(p: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(p))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** realpath of the nearest existing ancestor + the rest: /tmp vs /private/tmp must compare equal. */
async function realish(p: string): Promise<string> {
  let cur = resolve(p)
  const rest: string[] = []
  for (;;) {
    try { return join(await realpath(cur), ...rest) } catch { /* not there yet: try the parent */ }
    const up = dirname(cur)
    if (up === cur) return resolve(p)
    rest.unshift(basename(cur))
    cur = up
  }
}

/** `p` is the data dir or below it, symlinks resolved as far as the path exists. */
export async function insideDataDir(p: string, dataDir: string): Promise<boolean> {
  return isInside(p, dataDir) || isInside(await realish(p), await realish(dataDir))
}

/** Why `p` cannot be the default projects folder, or null when it can. Missing is fine (made on first use). */
export async function projectsFolderError(p: string, env: Pick<FolderEnv, 'dataDir'>): Promise<string | null> {
  const v = p.trim()
  if (!v || !isAbsolute(v)) return 'Use an absolute path, e.g. /Users/you/code.'
  if (await insideDataDir(v, env.dataDir)) return DATA_DIR_MESSAGE
  const st = await stat(v).catch(() => null)
  if (st && !st.isDirectory()) return 'That path is a file, not a folder.'
  return null
}

/** The configured folder when it is still valid, else the built-in default. Never throws. */
export async function projectsFolder(env: FolderEnv): Promise<string> {
  const c = env.configured.trim()
  if (c && !(await projectsFolderError(c, env))) return resolve(c)
  return builtinProjectsFolder(env.home, env.dataDir)
}

const isDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false)

/** Initial parent for a dialog: the remembered one while it is still a folder, else the default. */
export async function suggestedParent(remembered: string, env: FolderEnv): Promise<string> {
  const r = remembered.trim()
  if (r && isAbsolute(r) && (await isDir(r)) && !(await insideDataDir(r, env.dataDir))) return r
  return projectsFolder(env)
}

/** Exists and has entries: the clone / new project would be refused there. */
export async function isTaken(p: string): Promise<boolean> {
  return readdir(p).then((e) => e.length > 0, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT')
}

/** First of `name-2`, `name-3`, ... that is missing or empty in `parent`. */
export async function nextFreeName(parent: string, name: string, max = 1000): Promise<string | null> {
  for (let i = 2; i <= max; i++) {
    const candidate = `${name}-${i}`
    if (!(await isTaken(join(parent, candidate)))) return candidate
  }
  return null
}

export type WarningCode = 'data_dir' | 'inside_repo' | 'home'
export interface PlaceWarning { code: WarningCode; message: string; blocking: boolean }

/** Nearest ancestor of `target` (excluding itself) holding a `.git`, or null. */
async function enclosingRepo(target: string): Promise<string | null> {
  for (let dir = dirname(resolve(target)); ; dir = dirname(dir)) {
    if (await stat(join(dir, '.git')).then(() => true, () => false)) return dir
    if (dirname(dir) === dir) return null
  }
}

/** Wrong-place checks. Only `data_dir` blocks; the rest are offered with "Create anyway". */
export async function placeWarnings(target: string, env: Pick<FolderEnv, 'home' | 'dataDir'>): Promise<PlaceWarning[]> {
  const out: PlaceWarning[] = []
  if (await insideDataDir(target, env.dataDir)) {
    out.push({ code: 'data_dir', blocking: true, message: DATA_DIR_MESSAGE })
  }
  const home = resolve(env.home)
  if (resolve(target) === home || dirname(resolve(target)) === home) {
    out.push({ code: 'home', blocking: false, message: 'This puts the project directly in your home folder.' })
  }
  const repo = await enclosingRepo(target)
  if (repo) out.push({ code: 'inside_repo', blocking: false, message: `This is inside another git repository (${repo}).` })
  return out
}

export interface RevealDeps {
  platform?: NodeJS.Platform
  /** Starts `cmd args`; resolves once it started, rejects when it could not. Tests record argv. */
  spawn?: (cmd: string, args: string[]) => Promise<void>
}

const spawnDetached = (cmd: string, args: string[]): Promise<void> => new Promise((done, fail) => {
  const child = nodeSpawn(cmd, args, { stdio: 'ignore', detached: true })
  child.once('spawn', () => { child.unref(); done() })
  child.once('error', (e) => fail(new Error(`Could not run ${cmd}: ${e.message}`)))
})

/** Show `path` in the file manager: macOS `open -R path`, elsewhere `xdg-open` on its parent. argv, no shell. */
export function revealPath(path: string, deps: RevealDeps = {}): Promise<void> {
  const mac = (deps.platform ?? process.platform) === 'darwin'
  return (deps.spawn ?? spawnDetached)(mac ? 'open' : 'xdg-open', mac ? ['-R', path] : [dirname(path)])
}
