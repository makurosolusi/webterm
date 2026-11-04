/**
 * Shared blackboard (PLAN F5-b, PLAN/rnd/03 §1.4 + §4.3): labelled keys such as `goal:<id>/status` or
 * `decision:<topic>` that every agent reads ("update once, visible everywhere", Letta shared memory
 * blocks), so a node does not have to read another node's transcript to know where a goal stands.
 *
 * Storage is the v7 `memory` table, scope `blackboard`, project-less: history is the supersede chain
 * (Graphiti bi-temporal invalidation, nothing deleted) plus `memory_event`, and every write passes the
 * same write guard as memory (PII mask, tombstone, incognito, untrusted-only-claim). Hybrid retrieval
 * never serves scope `blackboard` (memoryHybrid scope allowlist), so the blackboard stays its own block.
 *
 * Who may write (Letta `read_only` blocks, made per key):
 *  - human (webterm UI): any key, directly; also confirms or rejects proposals;
 *  - an agent node: its own keys (`agent:<nodeId>` and `agent:<nodeId>/...`) directly, anything else only
 *    as a proposal that waits for a human;
 *  - Central: proposals only.
 * The body stores `<key> = <value>` rather than the bare value, so a forgotten short text ("done") can
 * never collide with an unrelated status through the tombstone hash.
 */
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, newId, tx } from '../ledger/ledgerCore'
import { contentHash } from '../memory/memoryConsolidate'
import { nodeRef } from '../memory/memoryControls'
import { appendMemoryEvent, memoryContext } from '../memory/memoryCore'
import { toMemoryRecord } from '../memory/memoryHybrid'
import { insertMemoryRow, supersedeRow } from '../memory/memoryInsert'
import { type MemoryAnyScope, MemoryAuthorityError, MemoryRejectedError, type MemoryRecord } from '../memory/memoryModel'
import { redactSecrets } from '../redactSecrets'

/**
 * The `memory.scope` column is free text; `MemoryAnyScope` lists only the scopes memory readers serve, and
 * the blackboard is deliberately not one of them (memoryHybrid never returns it), hence the cast.
 */
export const BLACKBOARD_SCOPE = 'blackboard' as unknown as MemoryAnyScope
export const BLACKBOARD_KEY_MAX = 160
export const BLACKBOARD_VALUE_MAX = 500
export const BLACKBOARD_HISTORY_MAX = 20
export const BLACKBOARD_SUMMARY_MAX_CHARS = 1200
export const BLACKBOARD_SUMMARY_HEADER =
  'Shared blackboard (webterm, read by every agent; read-only for you except keys agent:<your node id>/...):'
const LIST_MAX = 200
/** `<namespace>:<segment>[/<segment>...]`, e.g. `goal:auth-rewrite/status`, `decision:db-engine`. */
const KEY_RE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64}){0,3}$/
const PROPOSAL_MARK = '#proposal:'

export type BlackboardPrincipal = { kind: 'human'; id: string } | { kind: 'agent'; nodeId: string } | { kind: 'central'; id: string }

export interface BlackboardEntry {
  id: string
  key: string
  value: string
  /** `fact` = current value; `claim` = proposal waiting for a human; `superseded`/`quarantine` = history. */
  status: string
  by: string
  at: number
}

const sep = (key: string): string => `${key} = `
const valueOf = (r: MemoryRecord, key: string): string => (r.body.startsWith(sep(key)) ? r.body.slice(sep(key).length) : r.body)
const baseKey = (key: string): string => key.split('#')[0] ?? key
const actorOf = (p: BlackboardPrincipal): string => (p.kind === 'agent' ? nodeRef(p.nodeId) : p.id)

function entry(r: MemoryRecord): BlackboardEntry {
  const key = baseKey(r.key)
  return { id: r.id, key, value: redactSecrets(valueOf(r, key)), status: r.status, by: r.sourceRef ?? '', at: r.createdAt }
}

function reject(code: string, message: string): never {
  throw new MemoryRejectedError(code, message)
}

function cleanKey(key: unknown): string {
  if (typeof key !== 'string' || key.length > BLACKBOARD_KEY_MAX || !KEY_RE.test(key)) {
    reject('invalid_key', 'key must look like <namespace>:<name>[/<part>], e.g. goal:auth/status')
  }
  return key
}

function cleanValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') reject('invalid_shape', 'value must be a non-empty string')
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length > BLACKBOARD_VALUE_MAX) reject('too_long', `value exceeds ${BLACKBOARD_VALUE_MAX} characters`)
  if (redactSecrets(text) !== text) reject('secret_detected', 'value looks like a credential')
  return text
}

/** True when `key` belongs to `nodeId` (its own namespace on the board). */
export function isAgentScoped(key: string, nodeId: string): boolean {
  return key === `agent:${nodeId}` || key.startsWith(`agent:${nodeId}/`)
}

function current(db: Database, key: string): MemoryRecord | null {
  const row = getRow(db, "SELECT * FROM memory WHERE scope = ? AND project_id IS NULL AND key = ? AND status = 'fact' AND superseded_at IS NULL",
    BLACKBOARD_SCOPE, key)
  return row === null ? null : toMemoryRecord(row)
}

// `id` is passed in when a superseded row already points at it.
function insertRow(db: Database, p: BlackboardPrincipal, key: string, rowKey: string, value: string, status: 'claim' | 'fact', now: number, supersedes: string | null, id: string): void {
  const body = `${sep(key)}${value}`
  insertMemoryRow(db, {
    id, projectId: null, scope: BLACKBOARD_SCOPE, key: rowKey, title: key, body, status,
    kind: key.startsWith('decision:') ? 'decision' : 'fact', trust: p.kind === 'human' ? 'human' : 'agent',
    sourceKind: 'blackboard', sourceRef: actorOf(p), supersedes, contentHash: contentHash(key, body), staleAfter: null,
    verifiedAt: p.kind === 'human' ? now : null, now, sessionRef: p.kind === 'agent' ? nodeRef(p.nodeId) : null,
  })
}

export interface WriteResult { entry: BlackboardEntry; proposed: boolean; unchanged: boolean }

/** Writes `key` directly when the principal may, otherwise files a proposal. Same value = no new row. */
export function writeBlackboard(db: Database, p: BlackboardPrincipal, rawKey: unknown, rawValue: unknown, now: number): WriteResult {
  const key = cleanKey(rawKey)
  const value = cleanValue(rawValue)
  const direct = p.kind === 'human' || (p.kind === 'agent' && isAgentScoped(key, p.nodeId))
  return tx(memoryContext(db, now), () => {
    const cur = current(db, key)
    if (cur !== null && valueOf(cur, key) === value) return { entry: entry(cur), proposed: false, unchanged: true }
    if (!direct) {
      const pending = allRows(db, `SELECT * FROM memory WHERE scope = ? AND project_id IS NULL AND status = 'claim' AND superseded_at IS NULL
        AND substr(key, 1, ?) = ?`, BLACKBOARD_SCOPE, key.length + PROPOSAL_MARK.length, `${key}${PROPOSAL_MARK}`).map(toMemoryRecord)
      const same = pending.find((r) => valueOf(r, key) === value)
      if (same) return { entry: entry(same), proposed: true, unchanged: true }
      // No `supersedes` on a proposal: forgetting it must not walk into (and scrub) the current value.
      const id = newId()
      insertRow(db, p, key, `${key}${PROPOSAL_MARK}${id}`, value, 'claim', now, null, id)
      appendMemoryEvent(memoryContext(db, now), id, actorOf(p), 'blackboard.propose', { key, actorKind: p.kind }, now)
      return { entry: entry(loadRow(db, id)), proposed: true, unchanged: false }
    }
    const nextId = newId()
    if (cur !== null) supersedeRow(db, cur, now, nextId)
    insertRow(db, p, key, key, value, 'fact', now, cur?.id ?? null, nextId)
    appendMemoryEvent(memoryContext(db, now), nextId, actorOf(p), 'blackboard.write', { key, actorKind: p.kind, supersedes: cur?.id ?? null }, now)
    return { entry: entry(loadRow(db, nextId)), proposed: false, unchanged: false }
  })
}

function loadRow(db: Database, id: string): MemoryRecord {
  const row = getRow(db, 'SELECT * FROM memory WHERE id = ? AND scope = ?', id, BLACKBOARD_SCOPE)
  if (row === null) reject('not_found', `blackboard row not found: ${id}`)
  return toMemoryRecord(row)
}

/** Current values, key order; suppressed ("don't mention again") rows are hidden from readers. */
export function listBlackboard(db: Database): BlackboardEntry[] {
  return allRows(db, `SELECT * FROM memory WHERE scope = ? AND project_id IS NULL AND status = 'fact' AND superseded_at IS NULL
    AND suppressed_at IS NULL ORDER BY key LIMIT ?`, BLACKBOARD_SCOPE, LIST_MAX).map((r) => entry(toMemoryRecord(r)))
}

/** Proposals waiting for a human, oldest first. */
export function listProposals(db: Database): BlackboardEntry[] {
  return allRows(db, `SELECT * FROM memory WHERE scope = ? AND project_id IS NULL AND status = 'claim' AND superseded_at IS NULL
    ORDER BY created_at, id LIMIT ?`, BLACKBOARD_SCOPE, LIST_MAX).map((r) => entry(toMemoryRecord(r)))
}

/** Every value `key` ever had or was proposed to have, newest first. */
export function blackboardHistory(db: Database, rawKey: unknown, limit = BLACKBOARD_HISTORY_MAX): BlackboardEntry[] {
  const key = cleanKey(rawKey)
  return allRows(db, `SELECT * FROM memory WHERE scope = ? AND project_id IS NULL AND (key = ? OR substr(key, 1, ?) = ?)
    ORDER BY created_at DESC, rowid DESC LIMIT ?`, BLACKBOARD_SCOPE, key, key.length + 1, `${key}#`, Math.min(Math.max(1, limit), LIST_MAX))
    .map((r) => entry(toMemoryRecord(r)))
}

function pendingProposal(db: Database, p: BlackboardPrincipal, id: string, op: string): MemoryRecord {
  if (p.kind !== 'human') throw new MemoryAuthorityError(`${op}: only a human may do this`)
  const r = loadRow(db, id)
  if (r.status !== 'claim' || r.supersededAt !== null) reject('not_pending', `blackboard proposal ${id} is ${r.status}`)
  return r
}

/** A human accepts a proposal: it becomes the current value, the old value goes to history. */
export function confirmProposal(db: Database, p: BlackboardPrincipal, id: string, now: number): BlackboardEntry {
  return tx(memoryContext(db, now), () => {
    const r = pendingProposal(db, p, id, 'confirmProposal')
    if (r.trust === 'external') reject('untrusted_source', 'an untrusted proposal cannot be confirmed; write the value yourself')
    const key = baseKey(r.key)
    const cur = current(db, key)
    if (cur !== null) supersedeRow(db, cur, now, r.id)
    execWrite(db, "UPDATE memory SET status = 'fact', key = ?, verified_at = ?, updated_at = ?, valid_from = ?, supersedes = ? WHERE id = ?",
      key, now, now, now, cur?.id ?? null, r.id)
    appendMemoryEvent(memoryContext(db, now), r.id, actorOf(p), 'blackboard.confirm', { key, supersedes: cur?.id ?? null }, now)
    return entry(loadRow(db, r.id))
  })
}

/** A human turns a proposal down; it stays in history as `quarantine`. */
export function rejectProposal(db: Database, p: BlackboardPrincipal, id: string, now: number): BlackboardEntry {
  return tx(memoryContext(db, now), () => {
    const r = pendingProposal(db, p, id, 'rejectProposal')
    execWrite(db, "UPDATE memory SET status = 'quarantine', valid_to = ?, updated_at = ? WHERE id = ?", now, now, r.id)
    appendMemoryEvent(memoryContext(db, now), r.id, actorOf(p), 'blackboard.reject', { key: baseKey(r.key) }, now)
    return entry(loadRow(db, r.id))
  })
}

const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()

/** Awareness-card block: current values, newest first, whole lines packed into `maxChars`; '' when empty. */
export function blackboardSummary(db: Database, maxChars = BLACKBOARD_SUMMARY_MAX_CHARS): string {
  const rows = allRows(db, `SELECT * FROM memory WHERE scope = ? AND project_id IS NULL AND status = 'fact' AND superseded_at IS NULL
    AND suppressed_at IS NULL ORDER BY updated_at DESC, key LIMIT ?`, BLACKBOARD_SCOPE, LIST_MAX)
  const lines: string[] = []
  let used = BLACKBOARD_SUMMARY_HEADER.length
  for (const r of rows) {
    const e = entry(toMemoryRecord(r))
    const line = `- ${oneLine(e.key)}: ${oneLine(e.value)}`
    if (used + 1 + line.length > maxChars) break
    lines.push(line)
    used += 1 + line.length
  }
  return lines.length ? [BLACKBOARD_SUMMARY_HEADER, ...lines].join('\n') : ''
}
