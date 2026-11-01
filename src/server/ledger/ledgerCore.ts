import type { Database } from 'bun:sqlite'
import {
  LedgerError,
  type Agent,
  type LedgerEvent,
  type Project,
  type Row,
  type Task,
  type TaskStatus,
} from './ledgerModel'

export type { Row }

export interface LedgerContext {
  db: Database
  /** Injected clock; every write reads it unless the call passes its own `now`. */
  now: () => number
}

interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}

/** bun:sqlite ambient types cover only the slice db.ts uses; widen locally. */
export function stmt(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}

export function getRow(db: Database, sql: string, ...params: unknown[]): Row | null {
  return stmt(db, sql).get(...params)
}

export function allRows(db: Database, sql: string, ...params: unknown[]): Row[] {
  return stmt(db, sql).all(...params)
}

/** Runs a write and returns the affected row count. */
export function execWrite(db: Database, sql: string, ...params: unknown[]): number {
  const result = stmt(db, sql).run(...params) as { changes?: number } | undefined
  return typeof result?.changes === 'number' ? result.changes : 0
}

/** Runs an insert and returns the new rowid. */
export function execInsert(db: Database, sql: string, ...params: unknown[]): number {
  const result = stmt(db, sql).run(...params) as { lastInsertRowid?: number } | undefined
  return Number(result?.lastInsertRowid ?? 0)
}

/** True while an explicit BEGIN or db.transaction() is open on this connection. */
export function inTransaction(db: Database): boolean {
  return (db as unknown as { inTransaction?: boolean }).inTransaction === true
}

/**
 * Explicit BEGIN IMMEDIATE wrapper (db.transaction() is DEFERRED and can
 * deadlock two upgrading writers). Nested calls join the outer transaction so
 * task transitions and their events commit or roll back as one unit.
 */
export function tx<T>(ctx: LedgerContext, fn: () => T): T {
  if (inTransaction(ctx.db)) return fn()
  ctx.db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    ctx.db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      ctx.db.exec('ROLLBACK')
    } catch {
      // SQLite already rolled back; there is nothing left to undo.
    }
    throw err
  }
}

export function newId(): string {
  return crypto.randomUUID()
}

/** JSON column bind: undefined/null become SQL NULL, unserializable input is a caller bug. */
export function jsonOf(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch (err) {
    throw new LedgerError(`${label} must be JSON-serializable`, { cause: err })
  }
}

export function parseJson(value: unknown): unknown {
  return value === null || value === undefined ? null : JSON.parse(String(value))
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export function toProject(r: Row): Project {
  return {
    id: String(r['id']),
    workspaceId: String(r['workspace_id']),
    name: String(r['name']),
    path: String(r['path']),
    branchBase: nullableString(r['branch_base']),
    status: String(r['status']),
    priority: Number(r['priority']),
    budget: parseJson(r['budget_json']),
    lockEpoch: Number(r['lock_epoch']),
    approvedBy: nullableString(r['approved_by']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

export function toAgent(r: Row): Agent {
  return {
    id: String(r['id']),
    projectId: String(r['project_id']),
    parentAgentId: nullableString(r['parent_agent_id']),
    name: nullableString(r['name']),
    role: String(r['role']),
    depth: Number(r['depth']),
    capabilities: parseJson(r['capabilities_json']),
    sessionRef: nullableString(r['session_ref']),
    state: String(r['state']),
    heartbeatAt: nullableNumber(r['heartbeat_at']),
    createdAt: Number(r['created_at']),
  }
}

export function toTask(r: Row): Task {
  return {
    id: String(r['id']),
    projectId: String(r['project_id']),
    parentId: nullableString(r['parent_id']),
    agentId: nullableString(r['agent_id']),
    spec: String(r['spec']),
    specDigest: nullableString(r['spec_digest']),
    status: String(r['status']) as TaskStatus,
    fence: Number(r['fence']),
    leaseOwner: nullableString(r['lease_owner']),
    leaseExpires: nullableNumber(r['lease_expires']),
    heartbeatAt: nullableNumber(r['heartbeat_at']),
    attempt: Number(r['attempt']),
    maxAttempts: Number(r['max_attempts']),
    idemKey: nullableString(r['idem_key']),
    evidence: parseJson(r['evidence_json']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

export function toEvent(r: Row): LedgerEvent {
  return {
    seq: Number(r['seq']),
    ts: Number(r['ts']),
    projectId: nullableString(r['project_id']),
    taskId: nullableString(r['task_id']),
    runId: nullableString(r['run_id']),
    actor: String(r['actor']),
    kind: String(r['kind']),
    payload: parseJson(r['payload_json']),
    correlationId: nullableString(r['correlation_id']),
  }
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LedgerError(`${label} must be a non-empty string`)
  }
  return value
}
