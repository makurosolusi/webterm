/**
 * SQLite plumbing shared by the memory repository: context, row mapping, FTS
 * query hardening, and field validation. All SQL is parameterized.
 */
import type { Database } from 'bun:sqlite'
import {
  type LedgerContext,
  allRows,
  getRow,
  parseJson,
  requireText,
} from '../ledger/ledgerCore'
import {
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_PAST_SKEW_MS,
  MEMORY_ACTOR_KINDS,
  MEMORY_SCOPES,
  type MachineEvidence,
  type MemoryAuthority,
  MemoryAuthorityError,
  MemoryEvidenceError,
  MemoryNotFoundError,
  type Memory,
  type MemoryActorKind,
  type MemoryEvent,
  type MemoryScope,
  type MemoryStatus,
} from './memoryModel'

export type MemoryContext = LedgerContext

export function memoryContext(db: Database, now?: number): MemoryContext {
  return { db, now: now === undefined ? () => Date.now() : () => now }
}

export function toMemory(row: Record<string, unknown>): Memory {
  return {
    id: String(row['id']),
    projectId: row['project_id'] === null ? null : String(row['project_id']),
    scope: String(row['scope']) as MemoryScope,
    key: String(row['key']),
    title: String(row['title']),
    body: String(row['body']),
    status: String(row['status']) as MemoryStatus,
    sourceKind: row['source_kind'] === null ? null : String(row['source_kind']),
    sourceRef: row['source_ref'] === null ? null : String(row['source_ref']),
    supersedes: row['supersedes'] === null ? null : String(row['supersedes']),
    supersededAt: row['superseded_at'] === null ? null : Number(row['superseded_at']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  }
}

export function toMemoryEvent(row: Record<string, unknown>): MemoryEvent {
  return {
    seq: Number(row['seq']),
    memoryId: String(row['memory_id']),
    ts: Number(row['ts']),
    actor: String(row['actor']),
    kind: String(row['kind']),
    payload: parseJson(row['payload_json']),
  }
}

export function loadMemory(ctx: MemoryContext, id: string): Memory {
  const row = getRow(ctx.db, 'SELECT * FROM memory WHERE id = ?', id)
  if (!row) throw new MemoryNotFoundError(id)
  return toMemory(row)
}

export function findMemoryByKey(
  ctx: MemoryContext,
  projectId: string,
  scope: MemoryScope,
  key: string
): Memory | null {
  const row = getRow(
    ctx.db,
    'SELECT * FROM memory WHERE project_id = ? AND scope = ? AND key = ?',
    projectId,
    scope,
    key
  )
  return row ? toMemory(row) : null
}

export function parseScope(value: unknown): MemoryScope {
  const scope = (value ?? 'project') as MemoryScope
  if (!MEMORY_SCOPES.includes(scope)) {
    throw new MemoryEvidenceError(`memory.scope must be one of ${MEMORY_SCOPES.join(', ')}`)
  }
  return scope
}

/**
 * Validates the server-derived authority. There is deliberately no default: a caller that
 * forgets to pass who is acting must fail, not silently act as a worker (or worse, as a human).
 */
export function requireAuthority(value: MemoryAuthority | undefined): MemoryAuthority {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new MemoryAuthorityError('memory authority is required (server-derived, not from the payload)')
  }
  const kind = value.kind
  if (typeof kind !== 'string' || !MEMORY_ACTOR_KINDS.includes(kind as MemoryActorKind)) {
    throw new MemoryAuthorityError(
      `memory authority kind must be one of ${MEMORY_ACTOR_KINDS.join(', ')}, got ${String(kind)}`
    )
  }
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (id === '') throw new MemoryAuthorityError('memory authority id must be a non-empty string')
  return { kind: kind as MemoryActorKind, id }
}

/** Server-side evidence digests are sha256 hex; anything else is not verifier output. */
const EVIDENCE_DIGEST = /^[0-9a-f]{64}$/

/** Workers may never create facts; `core` is human-only even for orchestrators. */
export function assertCanPromote(
  actorKind: MemoryActorKind,
  scope: MemoryScope,
  operation: string
): void {
  if (actorKind === 'worker') {
    throw new MemoryAuthorityError(
      `${operation}: workers may only claim; promotion requires human or orchestrator`
    )
  }
  if (scope === 'core' && actorKind !== 'human') {
    throw new MemoryAuthorityError(`${operation}: scope 'core' is human-only`)
  }
}

/**
 * Validates machine evidence structurally. A claim promoted with `exitCode: 1`,
 * a missing `observedAt`, a free-text command, or a future timestamp is rejected:
 * those are the shapes a fabricated "it works" payload takes.
 */
export function validateEvidence(
  evidence: MachineEvidence | undefined,
  now: number,
  claimedAt: number,
  label: string
): MachineEvidence {
  if (evidence === undefined || evidence === null || typeof evidence !== 'object') {
    throw new MemoryEvidenceError(`${label}: machine evidence object is required`)
  }
  const command = requireText(evidence.command, `${label}.evidence.command`)
  if (command.trim().length > 500) {
    throw new MemoryEvidenceError(`${label}: evidence.command is too long`)
  }
  if (!Number.isInteger(evidence.exitCode)) {
    throw new MemoryEvidenceError(`${label}: evidence.exitCode must be an integer`)
  }
  if (evidence.exitCode !== 0) {
    throw new MemoryEvidenceError(
      `${label}: evidence.exitCode is ${evidence.exitCode}; only exit 0 can promote a claim`
    )
  }
  const observedAt = evidence.observedAt
  if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) {
    throw new MemoryEvidenceError(`${label}: evidence.observedAt must be epoch-ms`)
  }
  if (observedAt > now + EVIDENCE_FUTURE_SKEW_MS) {
    throw new MemoryEvidenceError(`${label}: evidence.observedAt is in the future (forged)`)
  }
  if (observedAt < claimedAt - EVIDENCE_PAST_SKEW_MS) {
    throw new MemoryEvidenceError(
      `${label}: evidence.observedAt predates the claim it is meant to support`
    )
  }
  const verified: MachineEvidence = { command, exitCode: 0, observedAt }
  const digest = evidence.digest
  if (digest !== undefined) {
    if (typeof digest !== 'string' || !EVIDENCE_DIGEST.test(digest)) {
      throw new MemoryEvidenceError(`${label}: evidence.digest must be a sha256 hex digest`)
    }
    verified.digest = digest.toLowerCase()
  }
  return verified
}

/** Appends an audit row; callers must already hold the write transaction. */
export function appendMemoryEvent(
  ctx: MemoryContext,
  memoryId: string,
  actor: string,
  kind: string,
  payload: unknown,
  at: number
): void {
  const db = ctx.db as unknown as {
    query(sql: string): { run(...params: unknown[]): unknown }
  }
  db.query(
    'INSERT INTO memory_event (memory_id, ts, actor, kind, payload_json) VALUES (?, ?, ?, ?, ?)'
  ).run(memoryId, at, actor, kind, payload === undefined ? null : JSON.stringify(payload))
}

export function memoryEventsOf(
  ctx: MemoryContext,
  memoryId: string,
  limit: number
): MemoryEvent[] {
  loadMemory(ctx, memoryId)
  return allRows(
    ctx.db,
    'SELECT * FROM memory_event WHERE memory_id = ? ORDER BY seq ASC LIMIT ?',
    memoryId,
    limit
  ).map(toMemoryEvent)
}

const MAX_QUERY_TOKENS = 12
const MAX_TOKEN_LENGTH = 64

/**
 * Turns arbitrary user input into a safe FTS5 expression. Every token is
 * double-quoted, so FTS operators and quotes in the input are inert; a query
 * such as `foo" OR body:bar` searches for the words foo/body/bar instead of
 * injecting syntax. Returns null when nothing searchable remains.
 */
export function toFtsQuery(query: string): string | null {
  if (typeof query !== 'string') {
    throw new MemoryEvidenceError('searchMemory: query must be a string')
  }
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((token) => token.length > 0)
    .slice(0, MAX_QUERY_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH).replace(/"/g, '""'))
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token}"`).join(' OR ')
}

/** Positive page size clamped to 100; invalid input is a caller bug. */
export function clampLimit(limit: number | undefined, fallback = 20): number {
  if (limit === undefined) return fallback
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new MemoryEvidenceError(`limit must be a positive number, got ${String(limit)}`)
  }
  return Math.min(100, Math.trunc(limit))
}

export function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    throw new MemoryEvidenceError(`offset must be a finite number, got ${String(offset)}`)
  }
  return Math.max(0, Math.trunc(offset))
}
