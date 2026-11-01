/**
 * P4b: memory files + git as durable truth for `fact` rows, behind
 * `WEBTERM_MEMORY_FILES=on` (default off); SQLite stays the rebuildable index.
 * - `writeMemoryFactFile` (only export): atomic 0600 Markdown, then git add/commit via
 *   fixed argv (no shell). Same authority rules as `promoteMemory`.
 * - `rebuildMemoryIndex` (only import, files-win): upserts facts, quarantines conflicts.
 * - Flag off: both inert, no filesystem, git, or SQL writes.
 * Path/port helpers live in `memoryFilePath`, render/parse in `memoryFileRender`; the public
 * names are re-exported here so callers keep importing `memoryFile`.
 */
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { type Row, requireText } from '../ledger/ledgerCore'
import { assertCanPromote, requireAuthority, toMemory } from './memoryCore'
import { type Memory, type MemoryAuthority, MemoryConflictError } from './memoryModel'
import { MemoryFileError, assertConfined, memoryFileRelPath, memoryFilesEnabled } from './memoryFilePath'
import type { MemoryFilePort } from './memoryFilePath'
import { DIGEST_PATTERN, oneLine, parseMemoryFile, renderMemoryFile } from './memoryFileRender'
import type { MemoryFileRecord } from './memoryFileRender'

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
    return typeof digest === 'string' && DIGEST_PATTERN.test(digest) ? digest : null
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

export {
  MEMORY_FILES_FLAG,
  MemoryFileError,
  assertConfined,
  createMemoryFilePort,
  memoryFileRelPath,
  memoryFilesEnabled,
  resolveInside,
  safeSegment,
} from './memoryFilePath'
export type {
  MemoryFileExecResult,
  MemoryFilePort,
  MemoryFileSpawn,
} from './memoryFilePath'
export { parseMemoryFile, renderMemoryFile } from './memoryFileRender'
export type { MemoryFileRecord } from './memoryFileRender'
