// New-worktree preparation, imitating Orca (docs/site/content/docs/model/orca-yaml.mdx):
//   - `.worktreeinclude` at the PRIMARY checkout's root: one literal path per line, `#` comments and
//     blank lines ignored, globs (`*`/`?`) and negation (`!`) skipped, no absolute/`..`/`.git` paths,
//     and only existing, gitignored entries are copied (a private copy, never a link).
//   - `scripts.setup` from the NEW worktree's `orca.yaml` (here `webterm.yaml` wins when both exist),
//     run with `bash -e` in the worktree with ORCA_ROOT_PATH / ORCA_WORKTREE_PATH / ORCA_WORKSPACE_NAME.
// Extra guard over Orca: an entry is copied only when it is ALSO ignored inside the new worktree, so
// a base branch whose .gitignore lacks `.env` can never turn the copied secret into a stageable file.
import { execFile, spawn } from 'node:child_process'
import { gitCommand } from './gitExec'
import { childEnv } from './childEnv'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

// Narrow local slice of Bun's API: @types/bun reddens unrelated files (same as pty.ts/nameGen.ts).
declare const Bun: { YAML: { parse(text: string): unknown } }

const run = promisify(execFile)
const INCLUDE_FILE = '.worktreeinclude'
const INCLUDE_MAX_BYTES = 256 * 1024 // Orca's cap on the include file
const INCLUDE_MAX_ENTRIES = 1000 // Orca's cap on literal candidates
const SETUP_FILES = ['webterm.yaml', 'orca.yaml'] as const
const OUTPUT_MAX_CHARS = 64 * 1024 // tail kept for the dialog
export const SETUP_TIMEOUT_MS = 10 * 60_000

export interface IncludeResult {
  copied: string[]
  /** `path: reason`, shown to the user as warnings. */
  skipped: string[]
}

export interface SetupResult {
  /** Config file the script came from, or null when there is no setup script. */
  source: string | null
  ran: boolean
  ok: boolean
  timedOut: boolean
  exitCode: number | null
  output: string
}

async function ignoredIn(root: string, rel: string): Promise<boolean> {
  try {
    const g = gitCommand(['-C', root, 'check-ignore', '-q', '--', rel])
    await run(g.file, g.args, { timeout: 5_000, env: g.env })
    return true
  } catch {
    return false // exit 1 = not ignored (tracked files are never reported ignored)
  }
}

/** Literal include candidates per Orca's format; problems come back as `skipped` reasons. */
export function parseWorktreeInclude(text: string): { paths: string[]; skipped: string[] } {
  const paths = new Set<string>()
  const skipped: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/[*?]/.test(line) || line.startsWith('!')) { skipped.push(`${line}: globs and negation are not supported`); continue }
    const p = line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const parts = p.split('/')
    if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || parts.some((s) => s === '' || s === '.' || s === '..' || s === '.git')) {
      skipped.push(`${line}: must be a relative path without "..", "." or ".git"`)
      continue
    }
    if (paths.size >= INCLUDE_MAX_ENTRIES) { skipped.push(`${line}: more than ${INCLUDE_MAX_ENTRIES} entries`); continue }
    paths.add(p)
  }
  return { paths: [...paths], skipped }
}

/** Copy `.worktreeinclude` entries from the primary checkout into the new worktree. */
export async function copyWorktreeIncludes(primary: string, worktree: string): Promise<IncludeResult> {
  const out: IncludeResult = { copied: [], skipped: [] }
  const file = join(primary, INCLUDE_FILE)
  let stat
  try { stat = await fs.lstat(file) } catch { return out } // no include file: nothing to copy
  if (!stat.isFile() || stat.size > INCLUDE_MAX_BYTES) {
    out.skipped.push(`${INCLUDE_FILE}: must be a regular file of at most 256 KiB`)
    return out
  }
  const parsed = parseWorktreeInclude(await fs.readFile(file, 'utf8'))
  out.skipped.push(...parsed.skipped)
  for (const rel of parsed.paths) {
    const src = join(primary, rel)
    let isDir: boolean
    try { isDir = (await fs.stat(src)).isDirectory() } catch { out.skipped.push(`${rel}: missing in ${primary}`); continue }
    // Trailing `/` so `dir/` patterns match in the new worktree, where the directory does not exist yet.
    const probe = isDir ? `${rel}/` : rel
    if (!(await ignoredIn(primary, probe))) { out.skipped.push(`${rel}: not gitignored (tracked files come from git)`); continue }
    if (!(await ignoredIn(worktree, probe))) { out.skipped.push(`${rel}: not gitignored on the new branch, refusing to copy`); continue }
    try {
      // ponytail: plain copy, no APFS clone and no 2 GiB budget; add both when someone lists big trees.
      await fs.cp(src, join(worktree, rel), { recursive: true, dereference: true, errorOnExist: false, force: false })
      out.copied.push(rel)
    } catch (err) {
      out.skipped.push(`${rel}: copy failed (${(err as NodeJS.ErrnoException).code ?? String(err)})`)
    }
  }
  return out
}

/** `scripts.setup` of the first config file present in `worktree`, or null. */
export async function readSetupScript(worktree: string): Promise<{ source: string; script: string } | null> {
  for (const name of SETUP_FILES) {
    let text: string
    try { text = await fs.readFile(join(worktree, name), 'utf8') } catch { continue }
    let doc: unknown
    try { doc = Bun.YAML.parse(text) } catch (err) {
      throw new Error(`Parse ${name} in ${worktree}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const setup = (doc as { scripts?: { setup?: unknown } } | null)?.scripts?.setup
    if (typeof setup === 'string' && setup.trim() !== '') return { source: name, script: setup }
  }
  return null
}

/** Run the setup script in the worktree; output is captured (tail-capped) for the dialog. */
export async function runSetupScript(primary: string, worktree: string, timeoutMs = SETUP_TIMEOUT_MS): Promise<SetupResult> {
  const found = await readSetupScript(worktree)
  if (!found) return { source: null, ran: false, ok: true, timedOut: false, exitCode: null, output: '' }
  // Filtered like a PTY (sec-208-7): repo code must not read the server's token or bot secrets.
  const env = childEnv({
    ORCA_ROOT_PATH: primary, ORCA_WORKTREE_PATH: worktree, ORCA_WORKSPACE_NAME: basename(worktree),
    WEBTERM_ROOT_PATH: primary, WEBTERM_WORKTREE_PATH: worktree,
  })
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_MAX_CHARS) }
    // Own process group so a timeout also kills the script's children: an orphan `sleep` would keep
    // the pipes open and the request hanging.
    const child = spawn('bash', ['-e', '-c', found.script], { cwd: worktree, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-(child.pid ?? 0), 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeoutMs)
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) output += `\n[webterm] setup timed out after ${Math.round(timeoutMs / 1000)}s`
      resolve({ source: found.source, ran: true, ok: code === 0 && !timedOut, timedOut, exitCode: code, output })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ source: found.source, ran: true, ok: false, timedOut: false, exitCode: null, output: `${output}\n[webterm] setup failed to start: ${err.message}` })
    })
  })
}
