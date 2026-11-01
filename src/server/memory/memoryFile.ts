/**
 * P4b: memory files + git as durable truth for `fact` rows, behind
 * `WEBTERM_MEMORY_FILES=on` (default off); SQLite stays the rebuildable index.
 * - `writeMemoryFactFile` (only export): atomic 0600 Markdown, then git add/commit via
 *   fixed argv (no shell). Same authority rules as `promoteMemory`.
 * - `rebuildMemoryIndex` (only import, files-win): upserts facts, quarantines conflicts.
 * - Flag off: both inert, no filesystem, git, or SQL writes.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Database } from 'bun:sqlite'
import { redactSecrets } from '../channels/webhook'
import { type Row, requireText } from '../ledger/ledgerCore'
import { assertCanPromote, requireAuthority, toMemory } from './memoryCore'
import { type Memory, type MemoryAuthority, MemoryAuthorityError, MemoryConflictError, MemoryError } from './memoryModel'

declare const Bun: {
  spawn(options: { cmd: string[]; cwd: string; env: Record<string, string>
    stdin: 'ignore'; stdout: 'pipe'; stderr: 'pipe' }): { exited: Promise<number>
    stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }
}

export const MEMORY_FILES_FLAG = 'WEBTERM_MEMORY_FILES'
const DIGEST = /^(?:sha256:)?([0-9a-f]{64})$/i
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SEGMENT = 96
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function memoryFilesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MEMORY_FILES_FLAG] === 'on'
}

export class MemoryFileError extends MemoryError {}

export interface MemoryFileExecResult { code: number; stdout: string; stderr: string }
export type MemoryFileSpawn = (file: string, args: string[], cwd: string) => Promise<MemoryFileExecResult>

/** Injectable file + git surface (real impl below; tests inject temp dirs/fakes). */
export interface MemoryFilePort {
  readonly root: string
  read(relPath: string): Promise<string | null>
  write(relPath: string, content: string): Promise<void>
  /** Regular files under `relDir`, sorted, posix separators. */
  list(relDir?: string): Promise<string[]>
  /** Runs a program via argv (no shell) and collects its output. */
  exec(file: string, args: string[], cwd: string): Promise<MemoryFileExecResult>
}


export interface MemorySqlDb {
  all(sql: string, ...params: unknown[]): Row[]
  run(sql: string, ...params: unknown[]): unknown
}

interface BunStatement { all(...params: unknown[]): Row[]; run(...params: unknown[]): unknown }

/** Accepts a bun:sqlite Database or an already-wrapped `MemorySqlDb`. */
export function memorySqlDb(source: Database | MemorySqlDb): MemorySqlDb {
  if (typeof (source as { query?: unknown }).query !== 'function') return source as MemorySqlDb
  const db = source as unknown as { query(s: string): BunStatement }
  return { all: (s, ...p) => db.query(s).all(...p), run: (s, ...p) => db.query(s).run(...p) }
}

export function safeSegment(value: string): string {
  const text = requireText(value, 'memoryFile.segment')
  if (SAFE_SEGMENT.test(text) && !text.includes('..') && text.length <= MAX_SEGMENT) return text
  const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 10)
  return `${slug === '' ? 'fact' : slug}-${digest}`
}

export function memoryFileRelPath(projectId: string, key: string): string {
  return `${safeSegment(projectId)}/${safeSegment(key)}.md`
}

/** Resolves `relPath` under `root`, refusing absolute and `..` escapes. */
export function resolveInside(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.includes('\0') || isAbsolute(relPath)) {
    throw new MemoryFileError(`memory file path must be relative: ${String(relPath)}`)
  }
  const rootPath = resolve(root)
  const full = relPath.trim() === '' ? rootPath : resolve(rootPath, relPath)
  if (full !== rootPath && !full.startsWith(rootPath + sep)) {
    throw new MemoryFileError(`memory file path escapes root: ${relPath}`)
  }
  return full
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** No symlink in the path may escape `root`. */
export async function assertConfined(root: string, relPath: string): Promise<void> {
  const rootReal = await realpathOrNull(resolve(root))
  if (rootReal === null) throw new MemoryFileError(`memory file root does not exist: ${root}`)
  const full = resolveInside(rootReal, relPath)
  const candidates = [full]
  for (let dir = dirname(full); dir !== rootReal && dir.startsWith(rootReal + sep); dir = dirname(dir)) {
    candidates.push(dir)
  }
  for (const candidate of [...candidates, rootReal]) {
    const real = await realpathOrNull(candidate)
    if (real !== null && real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new MemoryFileError(`memory file path escapes root via symlink: ${relPath}`)
    }
  }
}

function oneLine(value: string, max = 300): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function redacted(value: string, max: number): string {
  return redactSecrets(oneLine(value, max))
}

function evidenceField(digest: string | null | undefined): string | null {
  if (digest === null || digest === undefined) return null
  const match = DIGEST.exec(digest.trim())
  if (match === null) throw new MemoryFileError('memory file evidence must be a sha256 digest')
  return `sha256:${match[1].toLowerCase()}`
}

/** Deterministic Markdown with ordered JSON frontmatter. */
export function renderMemoryFile(memory: Memory, evidenceDigest?: string | null): string {
  if (memory.projectId === null) throw new MemoryFileError('memory file requires a project')
  if (memory.status !== 'fact') throw new MemoryConflictError(`memory file requires status fact, got ${memory.status}`)
  if (memory.scope === 'core') throw new MemoryAuthorityError('memory file: scope core is human-only, never exported')
  const frontmatter = {
    id: memory.id,
    projectId: memory.projectId,
    scope: memory.scope,
    key: memory.key,
    title: oneLine(memory.title),
    sourceKind: memory.sourceKind === null ? null : redacted(memory.sourceKind, 120),
    sourceRef: memory.sourceRef === null ? null : redacted(memory.sourceRef, 500),
    status: 'fact',
    evidence: evidenceField(evidenceDigest),
    updatedAt: memory.updatedAt,
  }
  const body = redactSecrets(memory.body).replace(/\s+$/, '')
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n# ${frontmatter.title}\n\n${body}\n`
}

export interface MemoryFileRecord {
  id: string; projectId: string; scope: 'project' | 'scratch'; key: string; title: string
  sourceKind: string | null; sourceRef: string | null; status: 'fact'
  evidence: string | null; updatedAt: number; body: string
}

function textField(fm: Record<string, unknown>, name: string, label: string, required: boolean): string | null {
  const value = fm[name]
  if (value === null || value === undefined) {
    if (required) throw new MemoryFileError(`${label}: frontmatter.${name} must be a non-empty string`)
    return null
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    throw new MemoryFileError(`${label}: frontmatter.${name} must be a string`)
  }
  return value
}

/** Parses one file; `core` is rejected because it is never file-backed. */
export function parseMemoryFile(text: string, label = 'memory file'): MemoryFileRecord {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new MemoryFileError(`${label}: missing JSON frontmatter`)
  let raw: unknown
  try {
    raw = JSON.parse(match[1])
  } catch (err) {
    throw new MemoryFileError(`${label}: frontmatter is not valid JSON`, { cause: err })
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemoryFileError(`${label}: frontmatter must be a JSON object`)
  }
  const fm = raw as Record<string, unknown>
  if (fm['scope'] === 'core') {
    throw new MemoryFileError(`${label}: scope core is human-only and never rebuilt from files`)
  }
  if (fm['scope'] !== 'project' && fm['scope'] !== 'scratch') {
    throw new MemoryFileError(`${label}: frontmatter.scope must be project or scratch`)
  }
  if (fm['status'] !== 'fact') throw new MemoryFileError(`${label}: frontmatter.status must be fact`)
  const updatedAt = fm['updatedAt']
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new MemoryFileError(`${label}: frontmatter.updatedAt must be epoch-ms`)
  }
  const rest = text.slice(match[0].length)
  const heading = /^\s*#\s+[^\n]*\n/.exec(rest)
  const evidence = textField(fm, 'evidence', label, false)
  return {
    id: textField(fm, 'id', label, true)!,
    projectId: textField(fm, 'projectId', label, true)!,
    scope: fm['scope'],
    key: textField(fm, 'key', label, true)!,
    title: textField(fm, 'title', label, true)!,
    sourceKind: textField(fm, 'sourceKind', label, false),
    sourceRef: textField(fm, 'sourceRef', label, false),
    status: 'fact',
    evidence: evidence === null ? null : evidenceField(evidence),
    updatedAt,
    body: (heading === null ? rest : rest.slice(heading[0].length)).replace(/^\s+|\s+$/g, ''),
  }
}

export interface WriteMemoryFileResult { status: 'written' | 'unchanged' | 'disabled'; relPath?: string; commit?: string | null }

function selectRow(sql: MemorySqlDb, where: string, ...params: unknown[]): Row | null {
  return sql.all(`SELECT * FROM memory WHERE ${where} LIMIT 1`, ...params)[0] ?? null
}

function evidenceDigestOf(sql: MemorySqlDb, id: string): string | null {
  const row = sql.all(
    "SELECT payload_json FROM memory_event WHERE memory_id = ? AND kind = 'memory.promote' ORDER BY seq DESC LIMIT 1",
    id
  )[0]
  const payload = row?.['payload_json']
  if (typeof payload !== 'string') return null
  try {
    const digest = (JSON.parse(payload) as { evidence?: { digest?: unknown } }).evidence?.digest
    return typeof digest === 'string' && DIGEST.test(digest) ? digest : null
  } catch {
    return null
  }
}

export function memoryCommitMessage(memory: Memory): string {
  return oneLine(`memory(${memory.projectId ?? 'none'}): record fact ${memory.key}`, 120)
}

export async function writeMemoryFactFile(
  source: Database | MemorySqlDb,
  authority: MemoryAuthority,
  id: string,
  port: MemoryFilePort
): Promise<WriteMemoryFileResult> {
  if (!memoryFilesEnabled()) return { status: 'disabled' }
  const actor = requireAuthority(authority)
  const memoryId = requireText(id, 'writeMemoryFactFile.id')
  const sql = memorySqlDb(source)
  const row = selectRow(sql, 'id = ?', memoryId)
  if (row === null) throw new MemoryConflictError(`memory not found: ${memoryId}`)
  const memory = toMemory(row)
  if (memory.status !== 'fact') throw new MemoryConflictError(`not a fact: ${memoryId} is ${memory.status}`)
  if (memory.projectId === null) throw new MemoryConflictError(`writeMemoryFactFile: ${memoryId} has no project`)
  assertCanPromote(actor.kind, memory.scope, 'writeMemoryFactFile')
  const relPath = memoryFileRelPath(memory.projectId, memory.key)
  await assertConfined(port.root, relPath)
  const content = renderMemoryFile(memory, evidenceDigestOf(sql, memory.id))
  if ((await port.read(relPath)) === content) return { status: 'unchanged', relPath, commit: null }
  await port.write(relPath, content)
  const added = await port.exec('git', ['add', '--', relPath], port.root)
  if (added.code !== 0) throw new MemoryFileError(`git add failed for ${relPath}: ${added.stderr.trim()}`)
  const commit = await port.exec('git', ['commit', '-m', memoryCommitMessage(memory), '--only', '--', relPath], port.root)
  if (commit.code !== 0) {
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
      return { status: 'unchanged', relPath, commit: null }
    }
    throw new MemoryFileError(`git commit failed for ${relPath}: ${commit.stderr.trim()}`)
  }
  return { status: 'written', relPath, commit: oneLine(commit.stdout.split('\n')[0] ?? '', 200) }
}

export interface MemoryRebuildRejection { file: string; reason: string }

export interface MemoryRebuildReport {
  status: 'rebuilt' | 'disabled'; projectId: string | null
  scanned: number; inserted: number; updated: number; unchanged: number
  quarantined: string[]; rejected: MemoryRebuildRejection[]
}

function emptyReport(projectId: string | null, status: 'rebuilt' | 'disabled'): MemoryRebuildReport {
  return { status, projectId, scanned: 0, inserted: 0, updated: 0, unchanged: 0, quarantined: [], rejected: [] }
}

function deterministicId(record: MemoryFileRecord): string {
  const seed = `${record.projectId}\u0000${record.scope}\u0000${record.key}`
  return `memf_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

function sameContent(row: Row, record: MemoryFileRecord): boolean {
  return row['status'] === 'fact' && String(row['title']) === record.title &&
    String(row['body']) === record.body && (row['source_kind'] ?? null) === record.sourceKind &&
    (row['source_ref'] ?? null) === record.sourceRef && Number(row['updated_at']) === record.updatedAt
}

function applyRecord(sql: MemorySqlDb, record: MemoryFileRecord, report: MemoryRebuildReport): void {
  const existing = selectRow(sql, 'project_id = ? AND scope = ? AND key = ?', record.projectId, record.scope, record.key)
  if (existing !== null) {
    if (sameContent(existing, record)) {
      report.unchanged += 1
      return
    }
    const set = "title = ?, body = ?, source_kind = ?, source_ref = ?, status = 'fact', updated_at = ?"
    sql.run(`UPDATE memory SET ${set} WHERE id = ?`,
      record.title, record.body, record.sourceKind, record.sourceRef, record.updatedAt, String(existing['id']))
    report.updated += 1
    return
  }
  const free = sql.all('SELECT id FROM memory WHERE id = ? LIMIT 1', record.id).length === 0
  const id = free ? record.id : deterministicId(record)
  if (sql.all('SELECT id FROM memory WHERE id = ? LIMIT 1', id).length > 0) {
    throw new MemoryFileError(`rebuildMemoryIndex: no free row id for ${record.projectId}/${record.key}`)
  }
  sql.run(
    `INSERT INTO memory (id, project_id, scope, key, title, body, status, source_kind, source_ref,
       supersedes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'fact', ?, ?, NULL, ?, ?)`,
    id, record.projectId, record.scope, record.key, record.title, record.body,
    record.sourceKind, record.sourceRef, record.updatedAt, record.updatedAt
  )
  report.inserted += 1
}

function quarantine(sql: MemorySqlDb, record: MemoryFileRecord, files: string[], report: MemoryRebuildReport): void {
  for (const file of files) report.quarantined.push(file)
  const rows = sql.all(
    "SELECT id FROM memory WHERE project_id = ? AND scope = ? AND key = ? AND status IN ('fact','claim')",
    record.projectId, record.scope, record.key
  )
  const payload = JSON.stringify({ reason: 'conflicting memory files for the same project/scope/key', files })
  for (const row of rows) {
    sql.run("UPDATE memory SET status = 'quarantine' WHERE id = ?", String(row['id']))
    sql.run(
      'INSERT INTO memory_event (memory_id, ts, actor, kind, payload_json) VALUES (?, ?, ?, ?, ?)',
      String(row['id']), Date.now(), 'memory-rebuild', 'memory.rebuild.quarantine', payload
    )
  }
}

/** Files-win rebuild: upsert facts by (project, scope, key); conflicting duplicates
 * quarantine the row; superseded/history rows are never touched. */
export async function rebuildMemoryIndex(
  source: Database | MemorySqlDb,
  port: MemoryFilePort,
  projectId?: string
): Promise<MemoryRebuildReport> {
  if (!memoryFilesEnabled()) return emptyReport(projectId ?? null, 'disabled')
  const sql = memorySqlDb(source)
  const report = emptyReport(projectId ?? null, 'rebuilt')
  const grouped = new Map<string, Array<{ file: string; record: MemoryFileRecord }>>()
  for (const file of await port.list('')) {
    if (!file.endsWith('.md')) continue
    const text = await port.read(file)
    if (text === null) continue
    let record: MemoryFileRecord
    try {
      record = parseMemoryFile(text, file)
    } catch (err) {
      report.rejected.push({ file, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (projectId !== undefined && record.projectId !== projectId) continue
    report.scanned += 1
    const group = `${record.projectId}\u0000${record.scope}\u0000${record.key}`
    const bucket = grouped.get(group)
    if (bucket === undefined) grouped.set(group, [{ file, record }])
    else bucket.push({ file, record })
  }
  for (const bucket of grouped.values()) {
    const first = bucket[0]
    if (first === undefined) continue
    const differs = bucket.some((e) => e.record.body !== first.record.body || e.record.title !== first.record.title)
    if (differs) quarantine(sql, first.record, bucket.map((e) => e.file), report)
    else applyRecord(sql, first.record, report)
  }
  return report
}

function bunSpawn(file: string, args: string[], cwd: string): Promise<MemoryFileExecResult> {
  if (typeof Bun === 'undefined') {
    return Promise.reject(new MemoryFileError('git exec requires Bun.spawn or an injected spawn'))
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env.GIT_TERMINAL_PROMPT = '0'
  const proc = Bun.spawn({ cmd: [file, ...args], cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    .then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
}

export function createMemoryFilePort(root: string, spawn?: MemoryFileSpawn): MemoryFilePort {
  const rootPath = resolve(root)
  return {
    root: rootPath,
    async read(relPath) {
      try {
        return await readFile(resolveInside(rootPath, relPath), 'utf8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return code === 'ENOENT' || code === 'EISDIR' ? null : Promise.reject(err)
      }
    },
    async write(relPath, content) {
      const full = resolveInside(rootPath, relPath)
      const dir = dirname(full)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const tmp = join(dir, `.${basename(full)}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`)
      const handle = await open(tmp, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
        await handle.chmod(0o600)
      } finally {
        await handle.close()
      }
      try {
        await rename(tmp, full)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    },
    async list(relDir = '') {
      const out: string[] = []
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.endsWith('.tmp')) continue
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
          else if (entry.isFile()) out.push(rel)
        }
      }
      await walk(resolveInside(rootPath, relDir), relDir)
      return out.sort()
    },
    exec(file, args, cwd) {
      return (spawn ?? bunSpawn)(file, args, cwd)
    },
  }
}
