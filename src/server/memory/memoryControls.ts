/**
 * Human memory controls (F5-a), after ChatGPT memory controls and Graphiti invalidation:
 * - list by cognitive kind with freshness (decays since last verification; low = surfaced for review);
 * - forget: content scrubbed from the row and its supersede history, tombstone left behind;
 * - don't mention again: `suppressed_at` (kept and listed, never served);
 * - edit: bi-temporal supersede (old row closed with `valid_to` + `superseded_by`, history kept);
 * - verify: re-verification resets freshness;
 * - incognito: a session ref from which nothing is stored.
 * Every write is human-only; the HTTP layer maps the principal (UI-only gate, memoryControls.api.ts).
 */
import type { Database } from 'bun:sqlite'
import { allRows, execInsert, execWrite, getRow, newId, tx } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import { contentHash } from './memoryConsolidate'
import { appendMemoryEvent, memoryContext } from './memoryCore'
import { liftTombstone, normalizedTextHash, tombstoneSubject } from './memoryGuard'
import { toMemoryRecord } from './memoryHybrid'
import { insertMemoryRow, supersedeRow } from './memoryInsert'
import { freshnessScore, REVIEW_FRESHNESS } from './memoryRrf'
import {
  type CognitiveKind, MemoryAuthorityError, type MemoryAuthority, MemoryRejectedError, type MemoryRecord,
} from './memoryModel'

export const FORGOTTEN_TEXT = '[forgotten]'
export const MEMORY_EDIT_MAX_CHARS = 1200
const LIST_MAX = 200
/** Supersede chains are short; the cap only bounds a corrupted cycle. */
const CHAIN_MAX = 50

/** One row of the memory panel. */
export interface MemoryItemView {
  id: string
  kind: CognitiveKind
  scope: string
  status: 'claim' | 'fact'
  trust: string
  origin: string | null
  title: string
  text: string
  suppressed: boolean
  /** 0..1, decays from the last verification. */
  freshness: number
  /** Freshness fell below one half-life: ask the human to verify or forget it. */
  needsReview: boolean
  validFrom: number | null
  updatedAt: number
}

function requireHuman(authority: MemoryAuthority, op: string): void {
  if (authority.kind !== 'human') throw new MemoryAuthorityError(`${op}: only a human may do this`)
}

const ACTIVE = "status IN ('claim','fact') AND superseded_at IS NULL"

function loadActive(db: Database, id: string): MemoryRecord {
  const row = getRow(db, `SELECT * FROM memory WHERE id = ? AND ${ACTIVE}`, id)
  if (row === null) throw new MemoryRejectedError('not_found', `memory not found: ${id}`)
  return toMemoryRecord(row)
}

function freshnessOf(r: MemoryRecord, now: number): number {
  return freshnessScore(r.kind, Math.max(r.verifiedAt ?? 0, r.updatedAt), now)
}

function view(r: MemoryRecord, now: number): MemoryItemView {
  const freshness = freshnessOf(r, now)
  return {
    id: r.id, kind: r.cognitiveKind, scope: r.scope, status: r.status as 'claim' | 'fact', trust: r.trust, origin: r.sourceKind,
    title: redactSecrets(r.title), text: redactSecrets(r.body), suppressed: r.suppressedAt !== null,
    freshness: Math.round(freshness * 1000) / 1000, needsReview: r.status === 'fact' && freshness < REVIEW_FRESHNESS,
    validFrom: r.validFrom, updatedAt: r.updatedAt,
  }
}

/** Active memories, optionally of one cognitive kind; facts needing review first, then newest. */
export function listMemoryItems(db: Database, now: number, kind?: CognitiveKind): MemoryItemView[] {
  const rows = kind === undefined
    ? allRows(db, `SELECT * FROM memory WHERE ${ACTIVE} ORDER BY updated_at DESC, id LIMIT ?`, LIST_MAX)
    : allRows(db, `SELECT * FROM memory WHERE ${ACTIVE} AND cognitive_kind = ? ORDER BY updated_at DESC, id LIMIT ?`, kind, LIST_MAX)
  const items = rows.map((row) => view(toMemoryRecord(row), now))
  return items.sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || (a.needsReview ? a.freshness - b.freshness : 0))
}

/**
 * Forgets a memory: tombstone (normalized text hash + subject), then the row and every row it
 * superseded are scrubbed (title/body/key) and quarantined, so neither retrieval, FTS nor a later
 * consolidation can bring the text back. Returns scope/key of the row so a `user` file can be removed.
 */
export function forgetMemory(db: Database, authority: MemoryAuthority, id: string, now: number): { scope: string; key: string } {
  requireHuman(authority, 'forgetMemory')
  return tx(memoryContext(db, now), () => {
    const record = loadActive(db, id)
    const hashes = new Set<string>()
    let cursor: string | null = record.id
    for (let i = 0; cursor !== null && i < CHAIN_MAX; i++) {
      const row = getRow(db, 'SELECT id, body, supersedes FROM memory WHERE id = ?', cursor)
      if (row === null) break
      hashes.add(normalizedTextHash(String(row['body'])))
      execWrite(db, `UPDATE memory SET title = ?, body = ?, key = ?, status = 'quarantine', valid_to = COALESCE(valid_to, ?),
        content_hash = NULL, updated_at = ? WHERE id = ?`, FORGOTTEN_TEXT, FORGOTTEN_TEXT, `forgotten:${String(row['id'])}`, now, now, row['id'])
      cursor = row['supersedes'] === null ? null : String(row['supersedes'])
    }
    for (const hash of hashes) {
      execInsert(db, `INSERT OR IGNORE INTO memory_tombstone (text_hash, subject, memory_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)`, hash, tombstoneSubject(record.projectId), record.id, authority.id, now)
    }
    appendMemoryEvent(memoryContext(db, now), record.id, authority.id, 'memory.forget', { actorKind: authority.kind, rows: hashes.size }, now)
    return { scope: record.scope, key: record.key }
  })
}

/** "Don't mention again" (on) or "mention again" (off); the row stays listed either way. */
export function suppressMemory(db: Database, authority: MemoryAuthority, id: string, on: boolean, now: number): MemoryItemView {
  requireHuman(authority, 'suppressMemory')
  return tx(memoryContext(db, now), () => {
    loadActive(db, id)
    execWrite(db, 'UPDATE memory SET suppressed_at = ? WHERE id = ?', on ? now : null, id)
    appendMemoryEvent(memoryContext(db, now), id, authority.id, on ? 'memory.suppress' : 'memory.unsuppress', { actorKind: authority.kind }, now)
    return view(loadActive(db, id), now)
  })
}

/** Re-verification: a human confirms a fact still holds; freshness restarts. */
export function verifyMemory(db: Database, authority: MemoryAuthority, id: string, now: number): MemoryItemView {
  requireHuman(authority, 'verifyMemory')
  return tx(memoryContext(db, now), () => {
    const record = loadActive(db, id)
    if (record.status !== 'fact') throw new MemoryRejectedError('not_a_fact', 'only facts can be verified; a claim needs confirmation')
    execWrite(db, 'UPDATE memory SET verified_at = ? WHERE id = ?', now, id)
    appendMemoryEvent(memoryContext(db, now), id, authority.id, 'memory.verify', { actorKind: authority.kind }, now)
    return view(loadActive(db, id), now)
  })
}

/**
 * A human corrects the text: the old row is closed (bi-temporal supersede) and a human fact with the
 * same slot replaces it. Untrusted (external) rows cannot be edited into a fact: add the rule yourself.
 */
export function editMemory(db: Database, authority: MemoryAuthority, id: string, text: unknown, now: number): MemoryItemView {
  requireHuman(authority, 'editMemory')
  if (typeof text !== 'string' || text.trim() === '') throw new MemoryRejectedError('invalid_shape', 'text must be a non-empty string')
  const body = text.replace(/\s+/g, ' ').trim()
  if (body.length > MEMORY_EDIT_MAX_CHARS) throw new MemoryRejectedError('too_long', `text exceeds ${MEMORY_EDIT_MAX_CHARS} characters`)
  if (redactSecrets(body) !== body) throw new MemoryRejectedError('secret_detected', 'text looks like a credential')
  return tx(memoryContext(db, now), () => {
    const old = loadActive(db, id)
    if (old.trust === 'external') throw new MemoryRejectedError('untrusted_source', 'untrusted content cannot be edited into a fact')
    const nextId = newId()
    // Procedural rows use the text as title (proceduralMemory); others keep their title.
    const title = old.kind === 'procedure' ? body.slice(0, 120) : old.title
    liftTombstone(db, old.projectId, body)
    supersedeRow(db, old, now, nextId)
    insertMemoryRow(db, {
      id: nextId, projectId: old.projectId, scope: old.scope, key: old.key, title, body, status: 'fact', kind: old.kind,
      trust: 'human', sourceKind: 'human-edit', sourceRef: authority.id, supersedes: old.id, contentHash: contentHash(title, body),
      staleAfter: null, verifiedAt: now, now,
    })
    appendMemoryEvent(memoryContext(db, now), nextId, authority.id, 'memory.edit', { actorKind: authority.kind, supersedes: old.id }, now)
    return view(loadActive(db, nextId), now)
  })
}

/** Session refs: `node:<id>` for an agent node, the conversation id for Central. */
export const nodeRef = (nodeId: string): string => `node:${nodeId}`

export function listIncognito(db: Database): string[] {
  return allRows(db, 'SELECT ref FROM memory_incognito ORDER BY since, ref LIMIT ?', LIST_MAX).map((r) => String(r['ref']))
}

export function setIncognito(db: Database, authority: MemoryAuthority, ref: string, on: boolean, now: number): string[] {
  requireHuman(authority, 'setIncognito')
  if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 200) throw new MemoryRejectedError('invalid_shape', 'ref must be a short non-empty string')
  if (on) execInsert(db, 'INSERT OR IGNORE INTO memory_incognito (ref, set_by, since) VALUES (?, ?, ?)', ref, authority.id, now)
  else execWrite(db, 'DELETE FROM memory_incognito WHERE ref = ?', ref)
  return listIncognito(db)
}
