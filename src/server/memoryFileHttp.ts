// HTTP surface for memory files (P4b): export one fact to Markdown+git, and rebuild the SQLite
// index from files. Both are write paths, so they stay behind `WEBTERM_MEMORY_FILES=on`.
//
// Authority is fixed `{kind:'human', id:'root'}` because the transport is root-only; a body can
// never declare itself human. Responses are compact status/relPath/counts: file contents, git
// output and tokens are never echoed.
import { isAbsolute, join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { MemoryAuthority } from './memory/memoryModel'
import {
  type MemoryFilePort,
  createMemoryFilePort,
  memoryFilesEnabled,
  rebuildMemoryIndex,
  writeMemoryFactFile,
} from './memory/memoryFile'
import { dataDir } from './config'
import { type RouteResult, capped, failure } from './memoryFileHttpResponse'

export type { RouteResult } from './memoryFileHttpResponse'

export const MEMORY_EXPORT_PATH = '/api/memory/export'
export const MEMORY_REBUILD_PATH = '/api/memory/rebuild'
export const MEMORY_DIR_ENV = 'WEBTERM_MEMORY_DIR'
const MAX_ID_CHARS = 200
/** Warned-once guard: a relative WEBTERM_MEMORY_DIR is ignored, and must not spam per request. */
const warnedRelativeDirs = new Set<string>()

export const MEMORY_FILE_AUTHORITY: MemoryAuthority = { kind: 'human', id: 'root' }

export interface MemoryFileHttpDeps {
  ledger: LedgerRuntime | null
  /** Defaults to `memoryFilesEnabled(env)`; tests may pin it. */
  enabled?: boolean
  env?: Record<string, string | undefined>
  /** Test seam: fake filesystem/git port. Production derives it from the data dir. */
  port?: MemoryFilePort
  dataDir?: () => string
}

export function isMemoryFilePath(path: string): boolean {
  return path === MEMORY_EXPORT_PATH || path === MEMORY_REBUILD_PATH
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > MAX_ID_CHARS ? null : trimmed
}

function memoryRoot(deps: MemoryFileHttpDeps, env: Record<string, string | undefined>): string {
  const configured = env[MEMORY_DIR_ENV]?.trim() ?? ''
  if (configured !== '') {
    if (isAbsolute(configured)) return configured
    if (!warnedRelativeDirs.has(configured)) {
      warnedRelativeDirs.add(configured)
      const safe = configured.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 120)
      console.warn(`memory dir ignored: ${MEMORY_DIR_ENV} must be absolute (got "${safe}")`)
    }
  }
  return join(deps.dataDir ? deps.dataDir() : dataDir(), 'memory')
}

async function exportFact(
  raw: Record<string, unknown>,
  db: Database,
  port: MemoryFilePort,
  enabled: boolean
): Promise<RouteResult> {
  const id = text(raw['id'])
  if (id === null) return { status: 400, body: { error: 'invalid_id' } }
  const result = await writeMemoryFactFile(db, MEMORY_FILE_AUTHORITY, id, port, enabled)
  if (result.status === 'disabled') return { status: 503, body: { error: 'memory_files_off' } }
  return {
    status: 200,
    body: { ok: true, status: result.status, ...(result.relPath ? { relPath: result.relPath } : {}) },
  }
}

async function rebuild(
  raw: Record<string, unknown>,
  db: Database,
  port: MemoryFilePort,
  enabled: boolean
): Promise<RouteResult> {
  let projectId: string | undefined
  if (raw['projectId'] !== undefined) {
    const parsed = text(raw['projectId'])
    if (parsed === null) return { status: 400, body: { error: 'invalid_project_id' } }
    projectId = parsed
  }
  const report = await rebuildMemoryIndex(db, port, projectId, enabled)
  if (report.status === 'disabled') return { status: 503, body: { error: 'memory_files_off' } }
  const quarantined = capped(report.quarantined)
  const rejected = capped(report.rejected)
  return {
    status: 200,
    body: {
      ok: true,
      status: report.status,
      projectId: report.projectId,
      scanned: report.scanned,
      inserted: report.inserted,
      updated: report.updated,
      unchanged: report.unchanged,
      quarantined: quarantined.items,
      quarantinedCount: quarantined.total,
      rejected: rejected.items,
      rejectedCount: rejected.total,
    },
  }
}

/** `null` = not a memory-file path (keep falling through). */
export async function memoryFileHttpRoute(
  path: string,
  method: string,
  body: unknown,
  deps: MemoryFileHttpDeps
): Promise<RouteResult | null> {
  if (!isMemoryFilePath(path)) return null
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const env = deps.env ?? process.env
  const enabled = deps.enabled ?? memoryFilesEnabled(env)
  if (!enabled) {
    return { status: 503, body: { error: 'memory_files_off' } }
  }
  const ledger = deps.ledger
  if (!ledger) return { status: 503, body: { error: 'ledger_off' } }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: 'invalid_body' } }
  }
  const raw = body as Record<string, unknown>
  // Resolve the root eagerly so a misconfigured WEBTERM_MEMORY_DIR warns even with a test port.
  const root = memoryRoot(deps, env)
  const port = deps.port ?? createMemoryFilePort(root)
  try {
    return path === MEMORY_EXPORT_PATH
      ? await exportFact(raw, ledger.db, port, enabled)
      : await rebuild(raw, ledger.db, port, enabled)
  } catch (err) {
    return failure(err)
  }
}
