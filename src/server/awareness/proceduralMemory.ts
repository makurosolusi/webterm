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
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, newId, tx } from '../ledger/ledgerCore'
import { redactSecrets } from '../redactSecrets'
import { contentHash } from '../memory/memoryConsolidate'
import { appendMemoryEvent, memoryContext } from '../memory/memoryCore'
import { insertMemoryRow } from '../memory/memoryInsert'
import { MemoryAuthorityError, MemoryRejectedError } from '../memory/memoryModel'
import { quarantineMemory } from '../memory/memoryWrite'

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
  return text
}

function toFact(r: Record<string, unknown>): ProceduralFact {
  return {
    id: String(r['id']), text: String(r['body']), status: r['status'] === 'fact' ? 'verified' : 'suggested',
    origin: String(r['source_kind']), updatedAt: Number(r['updated_at']), useCount: Number(r['use_count'] ?? 0),
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

function insert(db: Database, text: string, status: 'claim' | 'fact', origin: string, sourceRef: string, now: number): string {
  const id = newId()
  insertMemoryRow(db, {
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
  if (same !== null) return same['status'] === 'fact' ? toFact(same) : confirmProcedural(db, principal, String(same['id']), now)
  return tx(memoryContext(db, now), () => {
    const id = insert(db, clean, 'fact', HUMAN_UI, HUMAN_UI, now)
    appendMemoryEvent(memoryContext(db, now), id, HUMAN_UI, 'memory.procedural.add', { actorKind: 'human' }, now)
    return toFact(findById(db, id))
  })
}

/**
 * Anyone but a human proposes a rule; it stays `suggested` (a `claim`) until a human confirms it.
 * Same text as an existing fact or suggestion = no new row.
 */
export function suggestProcedural(db: Database, origin: SuggestOrigin, text: unknown, sourceRef: string, now = Date.now()): ProceduralFact {
  const clean = cleanText(text)
  const same = findActive(db, hashOf(clean))
  if (same !== null) return toFact(same)
  return tx(memoryContext(db, now), () => {
    const id = insert(db, clean, 'claim', origin, sourceRef.slice(0, 200), now)
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
    execWrite(db, "UPDATE memory SET status = 'fact', trust = 'human', verified_at = ?, updated_at = ? WHERE id = ?", now, now, id)
    appendMemoryEvent(memoryContext(db, now), id, HUMAN_UI, 'memory.procedural.confirm', { actorKind: 'human', origin: row['source_kind'] }, now)
    return toFact(findById(db, id))
  })
}

/** A human forgets a fact or rejects a suggestion (quarantined: history kept, never loaded again). */
export function forgetProcedural(db: Database, principal: string, id: string, now = Date.now()): void {
  requireHuman(principal, 'forgetProcedural')
  findById(db, id)
  quarantineMemory(db, { kind: 'human', id: HUMAN_UI }, { id, reason: 'forgotten in Settings', now })
}

const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()

/**
 * The SessionStart block: verified (human-trusted) facts only, newest first then most-used, whole
 * lines packed into `maxChars`. '' when there are none. Suggestions never appear here.
 */
export function proceduralBlock(db: Database, maxChars = PROCEDURAL_BLOCK_MAX_CHARS): string {
  const rows = allRows(db, `SELECT * FROM memory WHERE ${ACTIVE} AND status = 'fact' AND trust = 'human'
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
