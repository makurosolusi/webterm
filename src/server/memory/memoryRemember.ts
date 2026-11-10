/**
 * Central's memory write paths (RND/24 4, invariant I4 revised):
 *  - `rememberClaim`: a `claim` in scope `central`, trust `agent`, never a fact.
 *  - `rememberUser`: a `fact` in scope `user`, trust `attested`, only with a quote the SERVER
 *    verified against a real human message; the stored body IS the quote, not central's paraphrase.
 *  - `correctClaim` / `invalidateClaim`: change a visible claim; anything human-confirmed is refused.
 * None of them can write `core`, project facts or `global`. The actor is fixed to `central`.
 */
import type { Database } from 'bun:sqlite'
import { getRow, newId, tx } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import { archiveExpiredClaims, contentHash } from './memoryConsolidate'
import { attestUserQuote } from './memoryAttest'
import { appendMemoryEvent, memoryContext } from './memoryCore'
import { guardMemoryWrite } from './memoryGuard'
import { maskPii } from './memoryPii'
import { type NewMemoryRow, findActiveByHash, findRowByKey, insertMemoryRow, supersedeRow } from './memoryInsert'
import { getVisibleMemory } from './memoryHybrid'
import { MemoryConflictError, type MemoryKind, MemoryRejectedError, type MemoryRecord } from './memoryModel'
import type { UserMemoryStore } from './memoryUserStore'

export const MAX_BODY_CHARS = 1200
export const MAX_KEY_CHARS = 120
export const MAX_TITLE_CHARS = 120
export const MAX_REASON_CHARS = 300
/** Central writes per hour (RND/24 4). */
export const REMEMBER_RATE_PER_HOUR = 20
const HOUR_MS = 3_600_000
const EPISODE_TTL_MS = 90 * 86_400_000
const CENTRAL_ACTOR_PREFIX = 'central:'
/** `<domain>.<subject>.<predicate>`, lowercase, at least three segments. */
const CANONICAL_KEY = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){2,}$/
export const REMEMBER_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'decision', 'procedure', 'episode', 'summary']

/** Server-derived context of the calling turn; never taken from tool input. */
export interface RememberContext {
  conversationId: string
  /** Project of the conversation, or null for the global one. */
  projectId: string | null
  now: number
}

export interface RememberResult {
  record: MemoryRecord
  /** The same content already existed; nothing was written. */
  deduped: boolean
}

function reject(code: string, message: string): never {
  throw new MemoryRejectedError(code, message)
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') reject('invalid_shape', `${field} must be a non-empty string`)
  const text = value.trim()
  if (text.length > max) reject('too_long', `${field} exceeds ${max} characters`)
  if (redactSecrets(text) !== text) reject('secret_detected', `${field} looks like a credential`)
  // Rule 12: PII is masked before hashing, so dedupe and tombstones compare what is stored.
  return maskPii(text)
}

function cleanKey(value: unknown): string {
  const key = cleanText(value, 'key', MAX_KEY_CHARS)
  if (!CANONICAL_KEY.test(key)) reject('invalid_key', 'key must look like <domain>.<subject>.<predicate>')
  return key
}

function cleanKind(value: unknown, fallback: MemoryKind): MemoryKind {
  if (value === undefined) return fallback
  if (!REMEMBER_KINDS.includes(value as MemoryKind)) reject('invalid_shape', `kind must be one of ${REMEMBER_KINDS.join(', ')}`)
  return value as MemoryKind
}

function enforceRate(db: Database, now: number): void {
  const row = getRow(
    db,
    "SELECT COUNT(*) AS n FROM memory_event WHERE actor LIKE 'central:%' AND kind IN ('memory.claim','memory.remember_user','memory.update','memory.invalidate') AND ts > ?",
    now - HOUR_MS
  )
  if (Number(row?.['n'] ?? 0) >= REMEMBER_RATE_PER_HOUR) reject('rate_limited', `at most ${REMEMBER_RATE_PER_HOUR} central memory writes per hour`)
}

export interface ClaimInput { key: unknown; body: unknown; title?: unknown; kind?: unknown }

/** Records a central claim; same key + new content supersedes an older agent claim, same content dedupes. */
export function rememberClaim(db: Database, ctx: RememberContext, input: ClaimInput): RememberResult {
  const key = cleanKey(input.key)
  const body = cleanText(input.body, 'body', MAX_BODY_CHARS)
  const title = input.title === undefined ? key : cleanText(input.title, 'title', MAX_TITLE_CHARS)
  const kind = cleanKind(input.kind, 'fact')
  const hash = contentHash(title, body)
  return tx(memoryContext(db, ctx.now), () => {
    archiveExpiredClaims(db, ctx.now)
    const same = findActiveByHash(db, ctx.projectId, 'central', hash)
    if (same !== null) return { record: same, deduped: true }
    const old = findRowByKey(db, ctx.projectId, 'central', key)
    if (old !== null && (old.status !== 'claim' || old.trust !== 'agent')) {
      reject('key_exists', `central/${key} is held by a ${old.status} (${old.trust}); central cannot replace it`)
    }
    enforceRate(db, ctx.now)
    const row: NewMemoryRow = {
      id: newId(), projectId: ctx.projectId, scope: 'central', key, title, body, status: 'claim', kind, trust: 'agent',
      sourceKind: 'central', sourceRef: ctx.conversationId, supersedes: old?.id ?? null, contentHash: hash,
      staleAfter: kind === 'episode' || kind === 'summary' ? ctx.now + EPISODE_TTL_MS : null, verifiedAt: null, now: ctx.now,
      sessionRef: ctx.conversationId,
    }
    if (old !== null) supersedeRow(db, old, ctx.now, row.id)
    insertMemoryRow(db, row)
    appendMemoryEvent(memoryContext(db, ctx.now), row.id, `${CENTRAL_ACTOR_PREFIX}${ctx.conversationId}`, 'memory.claim',
      { actorKind: 'central', supersedes: old?.id ?? null }, ctx.now)
    return { record: findRowByKey(db, ctx.projectId, 'central', key) as MemoryRecord, deduped: false }
  })
}

/** A claim this conversation may change; hidden rows are `not_found`, human-confirmed ones `human_owned`. */
function loadOwnClaim(db: Database, ctx: RememberContext, id: unknown): MemoryRecord {
  const record = typeof id === 'string' ? getVisibleMemory(db, { projectId: ctx.projectId }, id, ctx.now) : null
  if (record === null) reject('not_found', `memory not found: ${String(id)}`)
  if (record.status !== 'claim' || record.trust === 'human') reject('human_owned', `memory ${record.id} is a ${record.status} (${record.trust}); only the user may change it`)
  return record
}

/** Corrects a visible claim by bi-temporal supersede: the origin stays on the new row, the corrector goes in the event. */
export function correctClaim(db: Database, ctx: RememberContext, input: { id: unknown; text: unknown }): RememberResult {
  const body = cleanText(input.text, 'text', MAX_BODY_CHARS)
  return tx(memoryContext(db, ctx.now), () => {
    const old = loadOwnClaim(db, ctx, input.id)
    // A derived title repeats the wrong text and FTS indexes it, so it is rebuilt; a key-as-title stays.
    const title = old.title === old.key ? old.key : body.slice(0, MAX_TITLE_CHARS)
    const hash = contentHash(title, body)
    if (hash === old.contentHash) return { record: old, deduped: true }
    enforceRate(db, ctx.now)
    const id = newId()
    supersedeRow(db, old, ctx.now, id)
    insertMemoryRow(db, {
      id, projectId: old.projectId, scope: old.scope, key: old.key, title, body, status: 'claim', kind: old.kind, trust: 'agent',
      sourceKind: old.sourceKind ?? 'central', sourceRef: old.sourceRef ?? ctx.conversationId, supersedes: old.id, contentHash: hash,
      staleAfter: old.staleAfter, verifiedAt: null, now: ctx.now, sessionRef: ctx.conversationId, sourceEventId: old.sourceEventId,
    })
    appendMemoryEvent(memoryContext(db, ctx.now), id, `${CENTRAL_ACTOR_PREFIX}${ctx.conversationId}`, 'memory.update', { actorKind: 'central', supersedes: old.id }, ctx.now)
    return { record: findRowByKey(db, old.projectId, old.scope, old.key) as MemoryRecord, deduped: false }
  })
}

/**
 * Closes a visible claim's validity window and frees its key. No tombstone and no scrub, unlike the
 * human `forgetMemory`: Central can be wrong about a claim being wrong, and the text may be true later.
 */
export function invalidateClaim(db: Database, ctx: RememberContext, input: { id: unknown; reason: unknown }): MemoryRecord {
  const reason = cleanText(input.reason, 'reason', MAX_REASON_CHARS)
  return tx(memoryContext(db, ctx.now), () => {
    const old = loadOwnClaim(db, ctx, input.id)
    enforceRate(db, ctx.now)
    supersedeRow(db, old, ctx.now, null)
    appendMemoryEvent(memoryContext(db, ctx.now), old.id, `${CENTRAL_ACTOR_PREFIX}${ctx.conversationId}`, 'memory.invalidate', { actorKind: 'central', reason }, ctx.now)
    return old
  })
}

export interface UserInput { key: unknown; quote: unknown; summary?: unknown; kind?: unknown }

/**
 * Stores an attested `user` fact. Order: verify the quote, check the slot, write the Markdown file
 * (source of truth), then the SQLite row; a failed insert removes the file again.
 */
export async function rememberUser(db: Database, ctx: RememberContext, input: UserInput, store?: UserMemoryStore): Promise<RememberResult> {
  const key = cleanKey(input.key)
  const attestation = attestUserQuote(db, ctx.conversationId, input.quote)
  const quote = maskPii(input.quote as string)
  const title = input.summary === undefined ? key : cleanText(input.summary, 'summary', MAX_TITLE_CHARS)
  const kind = cleanKind(input.kind, 'preference')
  if (kind === 'episode' || kind === 'summary') reject('invalid_shape', 'user memory kind must be fact, preference, decision or procedure')
  const hash = contentHash(title, quote)
  const plan = tx(memoryContext(db, ctx.now), () => {
    // Refuse before the file is written: an incognito or forgotten memory must not touch disk at all.
    guardMemoryWrite(db, { projectId: null, title, body: quote, status: 'fact', trust: 'attested', refs: [attestation.messageId, ctx.conversationId] })
    const same = findActiveByHash(db, null, 'user', hash)
    if (same !== null) return { deduped: same, old: null }
    const old = findRowByKey(db, null, 'user', key)
    if (old !== null && (old.status !== 'fact' || old.trust !== 'attested')) {
      reject('key_exists', `user/${key} is held by a ${old.status} (${old.trust}); central cannot replace it`)
    }
    enforceRate(db, ctx.now)
    return { deduped: null, old }
  })
  if (plan.deduped !== null) return { record: plan.deduped, deduped: true }
  const id = newId()
  const sourceRef = attestation.messageId
  await store?.write({ id, key, title, kind, trust: 'attested', sourceRef, updatedAt: ctx.now, body: quote })
  try {
    return tx(memoryContext(db, ctx.now), () => {
      const old = plan.old
      if (old !== null) {
        // Re-check inside the write transaction: another writer may have changed the slot since the plan.
        const current = findRowByKey(db, null, 'user', key)
        if (current?.id !== old.id || current.status !== 'fact') throw new MemoryConflictError(`user/${key} changed concurrently`)
        supersedeRow(db, old, ctx.now, id)
      }
      insertMemoryRow(db, {
        id, projectId: null, scope: 'user', key, title, body: quote, status: 'fact', kind, trust: 'attested',
        sourceKind: 'user_quote', sourceRef, supersedes: old?.id ?? null, contentHash: hash, staleAfter: null,
        verifiedAt: ctx.now, now: ctx.now, sessionRef: ctx.conversationId,
      })
      appendMemoryEvent(memoryContext(db, ctx.now), id, `${CENTRAL_ACTOR_PREFIX}${ctx.conversationId}`, 'memory.remember_user',
        { actorKind: 'central', messageId: sourceRef, quoteChars: quote.length, supersedes: old?.id ?? null }, ctx.now)
      return { record: findRowByKey(db, null, 'user', key) as MemoryRecord, deduped: false }
    })
  } catch (err) {
    // Undo the file write: restore the replaced fact's file, or drop the new one.
    if (plan.old === null) await store?.remove(key)
    else await store?.write({ id: plan.old.id, key, title: plan.old.title, kind: plan.old.kind, trust: 'attested', sourceRef: plan.old.sourceRef ?? '', updatedAt: plan.old.updatedAt, body: plan.old.body })
    throw err
  }
}
