// Deterministic project health scan (no model): lists `git ls-files`, reads text files within caps,
// runs the size / import-graph / TODO / empty-catch rules. Repo content is data: it is read and
// pattern-matched, never executed. git runs through gitExec (no hooks, no fsmonitor, no shell).
import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FindingDraft, HealthRule } from '../../../shared/centralHealth'
import { gitCommand } from '../../gitExec'
import { unreferencedFindings } from './healthRules.imports'
import { sizeFindings } from './healthRules.size'
import { emptyCatchFindings, todoFindings } from './healthRules.text'

/** Default cap on files read per scan. */
export const DEFAULT_MAX_FILES = 5000
/** Default cap on one file's size; larger files are skipped. */
export const DEFAULT_MAX_BYTES_PER_FILE = 1024 * 1024
/** Default wall-clock budget for one scan. */
export const DEFAULT_DEADLINE_MS = 20_000
/** Bytes inspected for a NUL to call a file binary. */
export const BINARY_SNIFF_BYTES = 8192
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

const VENDOR_DIR = /(^|\/)(node_modules|dist|vendor)\//
const MINIFIED = /\.min\.[^/]+$/
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'Pipfile.lock', 'uv.lock',
])

/** Options for {@link scanProject}. */
export interface ScanOptions { maxFiles?: number; maxBytesPerFile?: number; deadlineMs?: number; now?: () => number }
/** Outcome of {@link scanProject}. */
export interface ScanResult { drafts: FindingDraft[]; rules: HealthRule[]; filesScanned: number; truncated: boolean }

/** True for generated/vendor paths and lockfiles the scan never reads. */
export function isSkippedPath(path: string): boolean {
  return VENDOR_DIR.test(path) || MINIFIED.test(path) || LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1))
}

/** Tracked files of the repo at `cwd` (paths relative to `cwd`); throws with context when git fails. */
export async function trackedFiles(cwd: string): Promise<string[]> {
  const g = gitCommand(['-C', cwd, 'ls-files', '-z'])
  const out = await new Promise<string>((resolve, reject) => {
    execFile(g.file, g.args, { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: g.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`health scan: git ls-files failed in ${cwd} (not a git repository?): ${String(stderr).trim() || err.message}`))
      else resolve(String(stdout))
    })
  })
  return out.split('\0').filter(Boolean)
}

/** Reads a text file, or null when it is over `maxBytes`, binary, or no longer a regular file. */
export async function readText(abs: string, maxBytes: number): Promise<string | null> {
  const info = await stat(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null // tracked but deleted in the work tree
    throw new Error(`health scan: stat ${abs} failed: ${err.message}`)
  })
  if (!info || !info.isFile() || info.size > maxBytes) return null
  const fh = await open(abs, 'r')
  try {
    const buf = await fh.readFile()
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Scans the git project at `cwd` and returns finding drafts plus what was actually covered. */
export async function scanProject(cwd: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const now = opts.now ?? Date.now
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const candidates = (await trackedFiles(cwd)).filter((p) => !isSkippedPath(p))
  const texts = new Map<string, string>()
  let truncated = false
  for (const path of candidates) {
    if (texts.size >= maxFiles || now() >= deadline) { truncated = true; break }
    const text = await readText(join(cwd, path), maxBytes)
    if (text !== null) texts.set(path, text)
  }
  const drafts: FindingDraft[] = []
  for (const [path, text] of texts) {
    drafts.push(...sizeFindings(path, text), ...todoFindings(path, text), ...emptyCatchFindings(path, text))
  }
  const rules: HealthRule[] = ['file_size', 'todo_no_context', 'empty_catch']
  // A partial file set would report every module whose importer went unread, so the graph rule
  // runs only on a complete scan.
  if (!truncated) {
    drafts.push(...unreferencedFindings(texts))
    rules.push('unreferenced_module')
  }
  return { drafts, rules, filesScanned: texts.size, truncated }
}
