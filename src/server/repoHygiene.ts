// Secrets guard for workspace repos: for each workspace cwd that is a git repo, find UNTRACKED files
// whose NAME marks them as a secret (.env, private keys, cookie exports, cloud credentials) and append
// the matching patterns to that repo's `.gitignore`, so a later `git add .` cannot stage them.
//
// Names only — no file content is ever read. Tracked files that match are reported, never touched:
// un-tracking one (`git rm --cached`) rewrites the user's index and is their call, not ours.
//
// Pattern list imitates github/gitignore (Node.gitignore: `.env`, `.env.*`, `!.env.example`;
// Android.gitignore: `*.jks`, `*.keystore`) and gitleaks default rules (`pkcs12-file`: *.p12/*.pfx;
// `private-key`: PEM keys / ssh `id_*`). webterm's own root `.gitignore` carries the same list.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import npath from 'node:path'
import { promisify } from 'node:util'
import { resolveFsPath } from './fsOps'
import { gitCommand } from './gitExec'
import { createLogger } from './logs'

const log = createLogger('hygiene')
const run = promisify(execFile)

/** gitignore globs; a trailing `/` means "a directory with this name anywhere in the path". */
export const SECRET_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'credentials.json', 'service-account*.json',
  '*cookies*.txt', '.aws/', '.gcp/',
] as const

/** Committed-on-purpose dotenv templates (no values); never flagged, and re-included after `.env.*`. */
const SAFE_NAMES = ['.env.example', '.env.sample', '.env.template']

export const GUARD_MARKER = '# added by webterm: secrets guard'
export const HYGIENE_FINDINGS_PATH = '/api/hygiene/findings'

const GIT_TIMEOUT_MS = 5_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/** One flagged file: `ignored` = pattern now in .gitignore; `tracked` = already committed, left alone. */
export interface HygieneFinding {
  workspaceId: string
  path: string
  pattern: string
  action: 'ignored' | 'tracked'
}

const globRe = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
const MATCHERS = SECRET_PATTERNS.map((p) => ({ pattern: p, dir: p.endsWith('/'), re: globRe(p.replace(/\/$/, '')) }))

/** The secret pattern a path matches by name, or null. */
export function sensitivePattern(p: string): string | null {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const name = parts.at(-1)
  if (!name || SAFE_NAMES.includes(name)) return null
  const dirs = parts.slice(0, -1)
  for (const m of MATCHERS) {
    if (m.dir ? dirs.some((d) => m.re.test(d)) : m.re.test(name)) return m.pattern
  }
  return null
}

/** True when a path looks like a secret by name; for staging guards (SCM, agents) to refuse it. */
export function isSensitivePath(p: string): boolean {
  return sensitivePattern(p) !== null
}

async function gitLines(root: string, args: string[]): Promise<string[]> {
  const g = gitCommand(['-C', root, ...args])
  const { stdout } = await run(g.file, g.args, { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: g.env })
  return stdout.split('\0').filter(Boolean)
}

/** Repo root for a cwd, or null when the cwd is not inside a git work tree (or does not exist). */
async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const g = gitCommand(['-C', cwd, 'rev-parse', '--show-toplevel'])
    const { stdout } = await run(g.file, g.args, { timeout: GIT_TIMEOUT_MS, env: g.env })
    return stdout.trim() || null
  } catch {
    return null // not a repo: nothing to guard, by design
  }
}

/**
 * Add the missing `patterns` to `<root>/.gitignore` inside the marked block (created once at the end
 * of the file). Lines already present anywhere count as present, so re-runs are no-ops. Returns the
 * lines actually added.
 */
export async function ensureIgnored(root: string, patterns: string[]): Promise<string[]> {
  const file = npath.join(root, '.gitignore')
  const text = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return ''
    throw new Error(`read ${file} failed`, { cause: err })
  })
  const lines = text.split('\n')
  const present = new Set(lines.map((l) => l.trim()))
  const missing = [...new Set(patterns)].filter((p) => !present.has(p))
  if (missing.length === 0) return []
  const at = lines.findIndex((l) => l.trim() === GUARD_MARKER)
  let next: string
  if (at < 0) {
    const head = text === '' ? '' : `${text.endsWith('\n') ? text : `${text}\n`}\n`
    next = `${head}${[GUARD_MARKER, ...missing].join('\n')}\n`
  } else {
    let end = at + 1
    while (end < lines.length && lines[end].trim() !== '') end++
    lines.splice(end, 0, ...missing)
    next = lines.join('\n')
  }
  await fs.writeFile(file, next)
  return missing
}

interface RepoResult { root: string; ignored: { rel: string; pattern: string }[]; tracked: { rel: string; pattern: string }[] }

async function guardRepo(root: string): Promise<RepoResult> {
  const flag = (rels: string[]) => rels.flatMap((rel) => {
    const pattern = sensitivePattern(rel)
    return pattern ? [{ rel, pattern }] : []
  })
  // --exclude-standard: files already ignored are not listed, so a guarded repo yields nothing here.
  const ignored = flag(await gitLines(root, ['ls-files', '-z', '--others', '--exclude-standard']))
  const tracked = flag(await gitLines(root, ['ls-files', '-z']))
  const patterns = ignored.map((f) => f.pattern)
  if (patterns.includes('.env.*')) patterns.push(...SAFE_NAMES.map((n) => `!${n}`))
  const added = await ensureIgnored(root, patterns)
  if (added.length > 0) {
    log.warn('hygiene.ignored', `Secrets guard added ${added.length} pattern(s) to .gitignore in ${npath.basename(root)}`, {
      repo: root, patterns: added, files: ignored.map((f) => f.rel),
    })
  }
  if (tracked.length > 0) {
    log.warn('hygiene.tracked', `Secret-looking files are already tracked in ${npath.basename(root)}; left untouched`, {
      repo: root, files: tracked.map((f) => f.rel),
    })
  }
  return { root, ignored, tracked }
}

let findings: HygieneFinding[] = []

/** Latest scan result, for the UI. */
export function hygieneFindings(): HygieneFinding[] {
  return findings
}

/** Guard each given workspace cwd that is a git repo; replaces those workspaces' findings. Never throws per repo. */
export async function guardWorkspaceRepos(workspaces: { id: string; cwd?: string }[]): Promise<HygieneFinding[]> {
  const byRoot = new Map<string, Promise<RepoResult>>()
  const out: HygieneFinding[] = []
  for (const ws of workspaces) {
    if (!ws.cwd) continue
    try {
      const root = await repoRoot(resolveFsPath(ws.cwd))
      if (!root) continue
      if (!byRoot.has(root)) byRoot.set(root, guardRepo(root))
      const r = await byRoot.get(root)!
      for (const f of r.ignored) out.push({ workspaceId: ws.id, path: npath.join(r.root, f.rel), pattern: f.pattern, action: 'ignored' })
      for (const f of r.tracked) out.push({ workspaceId: ws.id, path: npath.join(r.root, f.rel), pattern: f.pattern, action: 'tracked' })
    } catch (err) {
      log.error('hygiene.failed', `Secrets guard failed for workspace ${ws.id}`, { error: err })
    }
  }
  const ids = new Set(workspaces.map((w) => w.id))
  findings = [...findings.filter((f) => !ids.has(f.workspaceId)), ...out]
  return out
}

/** `GET /api/hygiene/findings`; null for any other path/method. */
export function hygieneRoute(path: string, method: string): { status: number; body: unknown } | null {
  return path === HYGIENE_FINDINGS_PATH && method === 'GET' ? { status: 200, body: hygieneFindings() } : null
}
