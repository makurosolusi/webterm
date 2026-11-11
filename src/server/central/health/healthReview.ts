// H2 review gate: when a Central task enters `needs_review`, check only the files that task changed and
// record the findings as origin 'review' with its taskId, so the reviewer sees careless mistakes on the
// task card. "Changed" is the verifier's notion (verify.ts): the work tree plus the last commit, i.e.
// `git diff HEAD^` (empty tree for a root commit) plus untracked files. Text rules keep only the lines
// the diff added. Repo content is data: read and pattern-matched, never executed.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { FindingDraft, HealthRule } from '../../../shared/centralHealth'
import type { TaskView } from '../../../shared/centralWork'
import { gitCommand } from '../../gitExec'
import { getRow } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import { DEFAULT_BASE_REF } from '../../orchestrator/verifyCommands'
import type { WorkMove } from '../work/workModel'
import { findingFingerprint } from './healthFingerprint'
import { DEFAULT_MAX_BYTES_PER_FILE, DEFAULT_MAX_FILES, isSkippedPath, readText, trackedFiles } from './healthScan'
import { SOURCE_EXTENSIONS, extOf, isSizeExempt, isTestFile, sizeFindings } from './healthRules.size'
import { emptyCatchFindings, todoFindings } from './healthRules.text'
import type { HealthStore } from './healthStore'

const log = createLogger('central.health')
/** Rule citation for a new source file without a test. */
export const NEW_FILE_TEST_SOURCE = 'Rule 3 (global CLAUDE.md)'
/** Rules a review scan runs; only their open findings of the same task may be auto-fixed. */
export const REVIEW_RULES: HealthRule[] = ['file_size', 'todo_no_context', 'empty_catch', 'new_file_no_test']
/** git's empty tree: the base when HEAD has no parent. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
/** New files that need no test of their own: declarations, types, config, index re-exports, styles. */
const NO_TEST_NEEDED = [/\.d\.[^/]+$/, /(^|[/.])types?\.[^/]+$/, /(^|[/.])config\.[^/]+$/, /(^|\/)index\.[^/]+$/, /\.s?css$/]

/** One changed file: whether the task added it, and the 1-based lines it added ('all' for a new file). */
export interface ChangedFile { added: boolean; lines: Set<number> | 'all' }

/** Deps of {@link createHealthReview}; `cwdOf` = the project's checkout, null when it has none. */
export interface HealthReviewDeps { db: Database; store: HealthStore; now(): number; cwdOf(projectId: string): string | null }

/** Review gate observer; `idle` resolves once no review is running (test seam). */
export interface HealthReview { onMove(move: WorkMove): void; idle(): Promise<void> }

function git(cwd: string, args: string[]): Promise<string> {
  const g = gitCommand(['-C', cwd, ...args])
  return new Promise((resolve, reject) => {
    execFile(g.file, g.args, { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: g.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`health review: git ${args.join(' ')} failed in ${cwd}: ${String(stderr).trim() || err.message}`))
      else resolve(String(stdout))
    })
  })
}

const unquote = (p: string): string => {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p
  try { return JSON.parse(p) as string } catch { return p.slice(1, -1) } // git C-quoting is JSON-compatible except octal escapes
}

/** Changed files of a `git diff -U0 --src-prefix=a/ --dst-prefix=b/` output; deleted files are left out. */
export function parseDiff(out: string): Map<string, ChangedFile> {
  const files = new Map<string, ChangedFile>()
  let cur: ChangedFile | null = null
  let isNew = false
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) { cur = null; isNew = false; continue }
    if (line.startsWith('new file mode') || line === '--- /dev/null') { isNew = true; continue }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/\t$/, '')
      if (target === '/dev/null') { cur = null; continue }
      const path = unquote(target).replace(/^b\//, '')
      cur = { added: isNew, lines: isNew ? 'all' : new Set() }
      files.set(path, cur)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && cur && cur.lines !== 'all') {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let k = 0; k < count; k++) cur.lines.add(start + k)
    }
  }
  return files
}

/** What the task changed in the checkout at `cwd` (see the file head). Throws with context when git fails. */
export async function taskChanges(cwd: string): Promise<Map<string, ChangedFile>> {
  const diffArgs = (base: string) => ['diff', '-U0', '-M', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', base, '--']
  const hasParent = await git(cwd, ['rev-parse', '--verify', '--quiet', `${DEFAULT_BASE_REF}^{commit}`]).then(() => true, () => false)
  const files = parseDiff(await git(cwd, diffArgs(hasParent ? DEFAULT_BASE_REF : EMPTY_TREE)))
  for (const p of (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
    files.set(p, { added: true, lines: 'all' })
  }
  for (const p of [...files.keys()]) if (isSkippedPath(p)) files.delete(p)
  return files
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** True when a newly added `path` is source code Rule 3 expects a test for. */
export function needsTest(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extOf(path)) && !isTestFile(path) && !isSizeExempt(path) && !NO_TEST_NEEDED.some((re) => re.test(path))
}

/** new_file_no_test for `path` unless a test sharing its basename (`<base>.test.*`, `<base>.*.test.*`, `<base>.spec.*`) is among `known`. */
export function newFileNoTest(path: string, known: readonly string[]): FindingDraft[] {
  if (!needsTest(path)) return []
  const file = baseName(path)
  const base = file.slice(0, file.lastIndexOf('.')).toLowerCase()
  const re = new RegExp(`^${escapeRe(base)}\\.(?:[^/]+\\.)?(?:test|spec)\\.[^/]+$`)
  if (known.some((k) => isTestFile(k) && re.test(baseName(k).toLowerCase()))) return []
  return [{
    rule: 'new_file_no_test', severity: 'medium', confidence: 'medium', file: path, line: null,
    title: 'New file has no test', source: NEW_FILE_TEST_SOURCE,
    evidence: `${path} was added by this task; no ${base}.test.*, ${base}.*.test.* or ${base}.spec.* exists in the repo`,
    suggestion: 'Add a test with real assertions for the new behaviour, or say in review why none is needed.',
    fingerprint: findingFingerprint('new_file_no_test', path),
  }]
}

/** Review drafts for `changes`; fingerprints are scoped to the task so they never merge with project scan findings. */
export async function reviewDrafts(cwd: string, taskId: string, changes: Map<string, ChangedFile>): Promise<{ drafts: FindingDraft[]; filesScanned: number; truncated: boolean }> {
  const paths = [...changes.keys()].sort()
  const truncated = paths.length > DEFAULT_MAX_FILES
  const added = paths.filter((p) => changes.get(p)?.added)
  const known = added.length > 0 ? [...(await trackedFiles(cwd)), ...added] : []
  const drafts: FindingDraft[] = []
  let filesScanned = 0
  for (const path of paths.slice(0, DEFAULT_MAX_FILES)) {
    const change = changes.get(path) as ChangedFile
    const text = await readText(join(cwd, path), DEFAULT_MAX_BYTES_PER_FILE)
    if (text === null) continue
    filesScanned++
    const lines = change.lines
    const onAdded = (d: FindingDraft) => lines === 'all' || (d.line !== null && lines.has(d.line))
    drafts.push(...sizeFindings(path, text), ...[...todoFindings(path, text), ...emptyCatchFindings(path, text)].filter(onAdded))
    if (change.added) drafts.push(...newFileNoTest(path, known))
  }
  const scoped = drafts.map((d) => ({ ...d, fingerprint: findingFingerprint(d.rule, d.file, `review:${taskId}:${d.fingerprint}`) }))
  return { drafts: scoped, filesScanned, truncated }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Observer for `onWorkMove`: a move into needs_review starts one async review of that task's changes. */
export function createHealthReview({ db, store, cwdOf }: HealthReviewDeps): HealthReview {
  const running = new Map<string, Promise<void>>()
  const again = new Set<string>()
  const statusOf = (taskId: string): string | null => {
    const r = getRow(db, 'SELECT status FROM central_task WHERE id = ?', taskId)
    return r ? String(r['status']) : null
  }

  async function review(task: TaskView): Promise<void> {
    const ids = { taskId: task.id, projectId: task.projectId }
    const cwd = cwdOf(task.projectId)
    if (!cwd) return log.info('health.review_skipped', `review checks of task ${task.id} skipped: project ${task.projectId} has no checkout`, ids)
    const changes = await taskChanges(cwd)
    if (changes.size === 0) return log.info('health.review_skipped', `review checks of task ${task.id} skipped: no changed files`, ids)
    const scan = store.startScan(task.projectId, 'review')
    try {
      const result = await reviewDrafts(cwd, task.id, changes)
      store.finishScan(scan.id, { ...result, rules: REVIEW_RULES, taskId: task.id })
    } catch (err) {
      store.failScan(scan.id, `review of task ${task.id}: ${message(err)}`)
      throw err
    }
  }

  function start(task: TaskView): void {
    const run = Promise.resolve()
      .then(() => review(task))
      .catch((err: unknown) => log.warn('health.review_failed', `review checks of task ${task.id} failed`, { taskId: task.id, projectId: task.projectId, error: message(err) }))
      .finally(() => {
        running.delete(task.id)
        // A second entry into needs_review while this one ran: check the newer files once more.
        if (again.delete(task.id) && statusOf(task.id) === 'needs_review') start(task)
      })
    running.set(task.id, run)
  }

  return {
    onMove(move) {
      if (move.to !== 'needs_review') return
      try {
        if (running.has(move.task.id)) again.add(move.task.id)
        else start(move.task)
      } catch (err) {
        log.warn('health.review_failed', `review checks of task ${move.task.id} could not start`, { taskId: move.task.id, error: message(err) })
      }
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()])
    },
  }
}
