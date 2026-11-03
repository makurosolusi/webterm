// Project file scan for the knowledge index: git listing, exclusion of secrets, bounded safe reads,
// import extraction. Everything is read-only and confined to the project root.
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { allRows, getRow } from '../ledger/ledgerCore'
import { realPathInsideRoot } from '../orchestrator/safePath'
import type { Database } from 'bun:sqlite'
import { KB_MAX_FILE_BYTES, KnowledgeError } from './knowledgeStore'

declare const Bun: {
  Transpiler: new (opts: { loader: string }) => { scan(code: string): { exports: string[]; imports: Array<{ path: string; kind: string }> } }
}

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 256 * 1024 * 1024
const MAX_DISCOVER = 50
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git'])
const SECRET_NAMES = new Set(['credentials.json', 'service-account.json', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519'])
const SECRET_EXT = /\.(pem|key|p12|pfx|keystore)$/i
const LOADERS: Record<string, string> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx' }

/** True when a repo-relative path must never be indexed or read (secrets, deps, build output). */
export function isExcludedPath(rel: string): boolean {
  const parts = rel.split('/')
  const name = basename(rel)
  return parts.some((p) => EXCLUDED_DIRS.has(p)) || name.startsWith('.env') || SECRET_NAMES.has(name) || SECRET_EXT.test(name)
}

/** Language bucket by extension: a transpiler loader name, `md`, or `other`. */
export function langOf(rel: string): string {
  const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : ''
  return LOADERS[ext] ?? (ext === 'md' ? 'md' : 'other')
}

/** Runs git in `root` (argv array, no shell). Returns null when git exits non-zero (not a repo / empty repo). */
export async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['--no-optional-locks', '-C', root, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean }
    if (typeof e.code === 'number' && !e.killed) return null
    throw new KnowledgeError('git_failed', `git ${args[0]} failed in project root: ${e.code ?? e.message}`)
  }
}

/** True for a regular file (not a symlink); a file deleted since listing counts as not regular. */
function isRegularFile(abs: string): boolean {
  try { return lstatSync(abs).isFile() } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new KnowledgeError('stat_failed', `stat failed: ${(err as Error).message}`)
  }
}

export interface ListedFile { path: string; sha: string; tracked: boolean }

/** Tracked (index blob sha) plus untracked-not-ignored files, minus excluded paths, symlinks and submodules. */
export async function listFiles(root: string): Promise<ListedFile[] | null> {
  const tracked = await git(root, ['ls-files', '-s', '-z'])
  if (tracked === null) return null
  const out: ListedFile[] = []
  for (const entry of tracked.split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [mode = '', sha = ''] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    if (mode.startsWith('100') && !isExcludedPath(path)) out.push({ path, sha, tracked: true })
  }
  const untracked = (await git(root, ['ls-files', '-o', '--exclude-standard', '-z'])) ?? ''
  for (const path of untracked.split('\0')) if (path && !isExcludedPath(path) && isRegularFile(join(root, path))) out.push({ path, sha: 'untracked', tracked: false })
  return out
}

/** Reads a text file under `root` if it is a regular, non-excluded, non-symlink file within `maxBytes`; else null. */
export function readTextSafe(root: string, rel: string, maxBytes = KB_MAX_FILE_BYTES): string | null {
  if (isExcludedPath(rel)) return null
  const abs = resolve(root, rel)
  if (!realPathInsideRoot(root, abs)) return null
  let st
  try { st = lstatSync(abs) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new KnowledgeError('read_failed', `stat ${rel} failed: ${(err as Error).message}`)
  }
  if (!st.isFile() || st.size > maxBytes) return null
  return readFileSync(abs, 'utf8')
}

export interface ScannedFile { exports: string[]; imports: string[]; bytes: number }

/** Exports and import specifiers of one source file; unparsable or oversized files yield empty lists. */
export function scanSource(root: string, rel: string, loader: string): ScannedFile {
  const text = readTextSafe(root, rel)
  if (text === null) return { exports: [], imports: [], bytes: 0 }
  try {
    const scan = new Bun.Transpiler({ loader }).scan(text)
    return { exports: scan.exports, imports: [...new Set(scan.imports.map((i) => i.path))], bytes: text.length }
  } catch {
    // A file with a syntax error is still listed; it simply has no graph edges until it parses again.
    return { exports: [], imports: [], bytes: text.length }
  }
}

export interface DiscoveredWorkspace { workspaceId: string; name: string; cwd: string; gitRoot: string | null }

/** Workspaces whose cwd has no ledger project yet, with the git toplevel when the cwd is in a repo. */
export async function discoverProjects(ledger: Database, limit = MAX_DISCOVER): Promise<DiscoveredWorkspace[]> {
  if (!getRow(ledger, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'workspace'")) return []
  const rows = allRows(ledger, `SELECT w.id, w.name, w.cwd FROM workspace w
    WHERE NOT EXISTS (SELECT 1 FROM project p WHERE p.workspace_id = w.id OR p.path = w.cwd)
    ORDER BY w.updated_at DESC LIMIT ?`, Math.min(Math.max(limit, 1), MAX_DISCOVER))
  const out: DiscoveredWorkspace[] = []
  for (const r of rows) {
    const cwd = String(r.cwd)
    const top = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() ?? null
    out.push({ workspaceId: String(r.id), name: String(r.name), cwd, gitRoot: top ? join(top) : null })
  }
  return out
}
