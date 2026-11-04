// Procedural memory (PLAN F2-e, rnd/03 §1.1): the user's standing rules and preferences ("always run
// tests with TMPDIR=/tmp/st", "reply to me in Indonesian"), loaded into EVERY agent session.
//
// Imitated design: Letta shared memory blocks (docs.letta.com/guides/agents/memory-blocks): one labelled,
// size-limited block that is always in context, shared by every agent ("update once, visible
// everywhere") and read-only for the agents that see it. Here the block is rendered from the v7
// `memory` table (scope `user`, kind `procedure`), so Central's hybrid retrieval sees the same facts.
//
// Consent bridge + memory-poisoning guard (rnd/03 §1 "Memory poisoning"):
//  - only the `human-ui` principal (a same-origin webterm page, see procedural.api.ts) may ADD a
//    verified rule or CONFIRM a suggestion; any other principal gets MemoryAuthorityError;
//  - agents, Central and browser-derived content may only SUGGEST: a `claim` row. A claim in scope
//    `user` is invisible to every reader (memoryHybrid `visibility` serves user facts only), and
//    nothing here ever promotes one automatically; browser-derived rows also carry trust `external`.
//  - F5-a: an `external` suggestion (origin browser, or a source event labelled untrusted) can NEVER be
//    confirmed into a fact, not even by a click: a page saying "remember to always push to main" stays a
//    claim. A human who wants the rule types it with Add, which replaces the external claim.
//  - Forget leaves a tombstone (memoryControls.forgetMemory): the same text suggested again is refused.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, newId, tx } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import { contentHash } from '../memory/memoryConsolidate'
import { forgetMemory } from '../memory/memoryControls'
import { appendMemoryEvent, memoryContext } from '../memory/memoryCore'
import { liftTombstone } from '../memory/memoryGuard'
import { toMemoryRecord } from '../memory/memoryHybrid'
import { insertMemoryRow, supersedeRow } from '../memory/memoryInsert'
import { MemoryAuthorityError, MemoryRejectedError } from '../memory/memoryModel'
import { maskPii } from '../memory/memoryPii'

/** The only principal allowed to create or confirm procedural facts. */
export const HUMAN_UI = 'human-ui'
/** Who proposed a suggestion. `browser` = derived from web page content: the least trusted source. */
export type SuggestOrigin = 'agent' | 'central' | 'browser'
export const PROCEDURAL_TEXT_MAX_CHARS = 300
/** Budget for the SessionStart block (well under Claude Code's 10k `additionalContext` cap). */
export const PROCEDURAL_BLOCK_MAX_CHARS = 2000
export const PROCEDURAL_BLOCK_HEADER = 'Standing preferences the user set and confirmed in webterm Settings (apply them in this session):'
const TITLE_MAX_CHARS = 120
const LIST_MAX = 200

export interface ProceduralFact {
  id: string
  text: string
  /** `verified` = a human added or confirmed it; `suggested` = waiting for a human click. */
  status: 'verified' | 'suggested'
  /** Who wrote it first: `human-ui`, `agent`, `central` or `browser`. */
  origin: string
  updatedAt: number
  useCount: number
  /** Untrusted (web/browser-derived) suggestion: can never be confirmed, only replaced by a typed rule. */
  untrusted: boolean
  /** "Don't mention again": kept, never loaded into a session. */
  suppressed: boolean
}

const ACTIVE = "scope = 'user' AND project_id IS NULL AND kind = 'procedure' AND superseded_at IS NULL AND status IN ('claim','fact')"

function requireHuman(principal: string, op: string): void {
  if (principal !== HUMAN_UI) throw new MemoryAuthorityError(`${op}: only the webterm UI (human-ui) may do this, not ${principal}`)
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new MemoryRejectedError('invalid_shape', 'text must be a non-empty string')
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length > PROCEDURAL_TEXT_MAX_CHARS) throw new MemoryRejectedError('too_long', `text exceeds ${PROCEDURAL_TEXT_MAX_CHARS} characters`)
  if (redactSecrets(text) !== text) throw new MemoryRejectedError('secret_detected', 'text looks like a credential')
  return maskPii(text)
}

function toFact(r: Record<string, unknown>): ProceduralFact {
  return {
    id: String(r['id']), text: String(r['body']), status: r['status'] === 'fact' ? 'verified' : 'suggested',
    origin: String(r['source_kind']), updatedAt: Number(r['updated_at']), useCount: Number(r['use_count'] ?? 0),
    untrusted: r['trust'] === 'external', suppressed: r['suppressed_at'] !== null && r['suppressed_at'] !== undefined,
  }
}

const hashOf = (text: string): string => contentHash(text.slice(0, TITLE_MAX_CHARS), text)

function findActive(db: Database, hash: string): Record<string, unknown> | null {
  return getRow(db, `SELECT * FROM memory WHERE ${ACTIVE} AND content_hash = ? LIMIT 1`, hash)
}

function findById(db: Database, id: string): Record<string, unknown> {
  const row = getRow(db, `SELECT * FROM memory WHERE id = ? AND ${ACTIVE}`, id)
  if (row === null) throw new MemoryRejectedError('not_found', `procedural fact not found: ${id}`)
  return row
}

function insert(db: Database, text: string, status: 'claim' | 'fact', origin: string, sourceRef: string, now: number, sourceEventId: number | null = null): string {
  const id = newId()
  insertMemoryRow(db, {
    sourceEventId,
    id, projectId: null, scope: 'user', key: `user.procedure.${id}`, title: text.slice(0, TITLE_MAX_CHARS), body: text, status,
    kind: 'procedure', trust: status === 'fact' ? 'human' : origin === 'browser' ? 'external' : 'agent',
    sourceKind: origin, sourceRef, supersedes: null, contentHash: hashOf(text), staleAfter: null,
    verifiedAt: status === 'fact' ? now : null, now,
  })
  return id
}

/** Every active fact, verified first, newest first. For the Settings panel. */
export function listProcedural(db: Database): ProceduralFact[] {
  return allRows(db, `SELECT * FROM memory WHERE ${ACTIVE} ORDER BY status = 'fact' DESC, updated_at DESC, id LIMIT ?`, LIST_MAX).map(toFact)
}

/** A human adds a verified rule. Adding the text of a pending suggestion confirms that suggestion. */
export function addProcedural(db: Database, principal: string, text: unknown, now = Date.now()): ProceduralFact {
  requireHuman(principal, 'addProcedural')
  const clean = cleanText(text)
  const same = findActive(db, hashOf(clean))
  if (same !== null && same['trust'] !== 'external') {
    return same['status'] === 'fact' ? toFact(same) : confirmProcedural(db, principal, String(same['id']), now)
  }
  return tx(memoryContext(db, now), () => {
    // Typing a forgotten rule again is a deliberate human act: it lifts the tombstone.
    liftTombstone(db, null, clean)
    // The human's own rule replaces an untrusted suggestion with the same text (history kept).
    if (same !== null) supersedeRow(db, toMemoryRecord(same), now)
    const id = insert(db, clean, 'fact', HUMAN_UI, HUMAN_UI, now)
    if (same !== null) execWrite(db, 'UPDATE memory SET superseded_by = ? WHERE id = ?', id, same['id'])
    appendMemoryEvent(memoryContext(db, now), id, HUMAN_UI, 'memory.procedural.add', { actorKind: 'human' }, now)
    return toFact(findById(db, id))
  })
}

/**
 * Anyone but a human proposes a rule; it stays `suggested` (a `claim`) until a human confirms it.
 * Same text as an existing fact or suggestion = no new row.
 */
export function suggestProcedural(
  db: Database, origin: SuggestOrigin, text: unknown, sourceRef: string, now = Date.now(), sourceEventId: number | null = null,
): ProceduralFact {
  const clean = cleanText(text)
  const same = findActive(db, hashOf(clean))
  if (same !== null) return toFact(same)
  return tx(memoryContext(db, now), () => {
    const id = insert(db, clean, 'claim', origin, sourceRef.slice(0, 200), now, sourceEventId)
    appendMemoryEvent(memoryContext(db, now), id, origin, 'memory.procedural.suggest', { actorKind: origin }, now)
    return toFact(findById(db, id))
  })
}

/** The consent bridge: a human click turns a suggestion into a verified fact. */
export function confirmProcedural(db: Database, principal: string, id: string, now = Date.now()): ProceduralFact {
  requireHuman(principal, 'confirmProcedural')
  return tx(memoryContext(db, now), () => {
    const row = findById(db, id)
    if (row['status'] === 'fact') return toFact(row)
    if (row['trust'] === 'external') {
      throw new MemoryRejectedError('untrusted_source', 'a suggestion from an untrusted source cannot be confirmed; add the rule yourself')
    }
    execWrite(db, "UPDATE memory SET status = 'fact', trust = 'human', verified_at = ?, updated_at = ? WHERE id = ?", now, now, id)
    appendMemoryEvent(memoryContext(db, now), id, HUMAN_UI, 'memory.procedural.confirm', { actorKind: 'human', origin: row['source_kind'] }, now)
    return toFact(findById(db, id))
  })
}

/** A human forgets a fact or rejects a suggestion: content scrubbed, tombstone left so it cannot come back. */
export function forgetProcedural(db: Database, principal: string, id: string, now = Date.now()): void {
  requireHuman(principal, 'forgetProcedural')
  findById(db, id)
  forgetMemory(db, { kind: 'human', id: HUMAN_UI }, id, now)
}

const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()

/**
 * The SessionStart block: verified (human-trusted) facts only, newest first then most-used, whole
 * lines packed into `maxChars`. '' when there are none. Suggestions never appear here.
 */
export function proceduralBlock(db: Database, maxChars = PROCEDURAL_BLOCK_MAX_CHARS): string {
  const rows = allRows(db, `SELECT * FROM memory WHERE ${ACTIVE} AND status = 'fact' AND trust = 'human' AND suppressed_at IS NULL
    ORDER BY updated_at DESC, use_count DESC, id LIMIT ?`, LIST_MAX)
  const lines: string[] = []
  let used = PROCEDURAL_BLOCK_HEADER.length
  for (const r of rows) {
    const line = `- ${oneLine(redactSecrets(String(r['body'])))}`
    if (used + 1 + line.length > maxChars) break
    lines.push(line)
    used += 1 + line.length
  }
  return lines.length ? [PROCEDURAL_BLOCK_HEADER, ...lines].join('\n') : ''
}
