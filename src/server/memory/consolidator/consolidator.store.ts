// Consolidator proposals in the memory ledger. Every proposed op is a `claim` (scope `central`, source kind
// `consolidator`), written through the shared write guard (memoryGuard: PII mask, tombstones, incognito,
// untrusted-only-claim), deduped by content hash, and expires unconfirmed after PROPOSAL_TTL_MS
// (archiveExpiredClaims). Only a human turns one into memory: add → fact (procedure → a verified
// procedural rule), update → editMemory supersede, invalidate → the target's validity window is closed.
// The op and its target travel in the row key: `consolidate.<op>.<targetId|new>.<hash16>`.
import type { Database } from 'bun:sqlite'
import { addProcedural, HUMAN_UI } from '../../awareness/proceduralMemory'
import { recordHelperUsage, type HelperUsage } from '../../cost/costCapture'
import { allRows, execWrite, getRow, newId, tx } from '../../ledger/ledgerCore'
import { redactSecrets } from '../../redactSecrets'
import { archiveExpiredClaims, contentHash } from '../memoryConsolidate'
import { editMemory, nodeRef } from '../memoryControls'
import { appendMemoryEvent, memoryContext } from '../memoryCore'
import { toMemoryRecord } from '../memoryHybrid'
import { insertMemoryRow, supersedeRow } from '../memoryInsert'
import { MemoryAuthorityError, MemoryConflictError, MemoryRejectedError, type MemoryAuthority, type MemoryRecord } from '../memoryModel'
import { type ConsolidationOp, KNOWN_MAX, type KnownMemory, type ProposedOp } from './consolidator.model'

export const CONSOLIDATOR_SOURCE = 'consolidator'
/** Tokens (input + output + cache) the consolidator may spend per rolling 24 hours. */
export const CONSOLIDATOR_DAILY_TOKENS = 200_000
export const PROPOSAL_TTL_MS = 30 * 86_400_000
const DAY_MS = 86_400_000
const TITLE_MAX = 120
const LIST_MAX = 200
const USAGE_PREFIX = 'consolidator:'
const ACTIVE = "status IN ('claim','fact') AND superseded_at IS NULL"
const PENDING = `scope = 'central' AND source_kind = '${CONSOLIDATOR_SOURCE}' AND status = 'claim' AND superseded_at IS NULL`

export interface ProposalView {
  id: string
  op: ConsolidationOp
  kind: string
  text: string
  targetId: string | null
  /** Current text of the target (update/invalidate); null when it is gone. */
  targetText: string | null
  /** Derived from an untrusted (web) source: can be dismissed, never confirmed. */
  untrusted: boolean
  sourceEventId: number | null
  node: string | null
  createdAt: number
}

export interface WriteOutcome { written: string[]; skipped: Array<{ text: string; code: string }> }

const parseKey = (key: string): { op: ConsolidationOp; targetId: string | null } => {
  const [, op, target] = key.split('.')
  return { op: op as ConsolidationOp, targetId: target === undefined || target === 'new' ? null : target }
}

/** Active, unsuppressed memories the model may update/invalidate (newest first). Blackboard rows stay out. */
export function knownMemories(db: Database, limit = KNOWN_MAX): KnownMemory[] {
  return allRows(db, `SELECT id, kind, body FROM memory WHERE status = 'fact' AND superseded_at IS NULL AND suppressed_at IS NULL
    AND scope IN ('central','user','global') ORDER BY updated_at DESC, id LIMIT ?`, limit)
    .map((r) => ({ id: String(r['id']), kind: String(r['kind']), text: redactSecrets(String(r['body'])) }))
}

/** Tokens spent by consolidator runs in the last 24 hours (cost ledger rows keyed `consolidator:<run>`). */
export function tokensToday(db: Database, now: number): number {
  const r = getRow(db, `SELECT COALESCE(SUM(input + output + cache_read + cache_write_5m + cache_write_1h), 0) AS n FROM cost_usage
    WHERE ts >= ? AND substr(key, 1, ?) = ?`, now - DAY_MS, USAGE_PREFIX.length, USAGE_PREFIX)
  return Number(r?.['n'] ?? 0)
}

export type RunUsage = HelperUsage

/** Books one run as helper `consolidator` (key `consolidator:<run>`), so the cap, the spend dashboard and the day budget all see it. */
export function recordRunUsage(db: Database, runId: string, nodeId: string | null, u: RunUsage, now: number): void {
  recordHelperUsage(db, 'consolidator', u, { id: runId, nodeId, now: () => now })
}

const hasActiveHash = (db: Database, hash: string): boolean =>
  getRow(db, `SELECT 1 AS one FROM memory WHERE content_hash = ? AND ${ACTIVE} LIMIT 1`, hash) !== null

/**
 * Files each op as a claim. A forgotten text, an incognito node or a duplicate is skipped with its code;
 * nothing here can produce a fact. `sourceEventId` = the Senses event the session was read at (provenance).
 */
export function writeProposals(db: Database, ops: readonly ProposedOp[], src: { nodeId: string | null; sourceEventId: number | null }, now: number): WriteOutcome {
  const out: WriteOutcome = { written: [], skipped: [] }
  const ref = src.nodeId === null ? CONSOLIDATOR_SOURCE : nodeRef(src.nodeId)
  tx(memoryContext(db, now), () => archiveExpiredClaims(db, now))
  for (const o of ops) {
    const title = o.text.slice(0, TITLE_MAX)
    const hash = contentHash(title, o.text)
    if (hasActiveHash(db, hash)) { out.skipped.push({ text: o.text, code: 'duplicate' }); continue }
    const id = newId()
    try {
      tx(memoryContext(db, now), () => {
        insertMemoryRow(db, {
          id, projectId: null, scope: 'central', key: `consolidate.${o.op}.${o.targetId ?? 'new'}.${hash.slice(0, 16)}`, title, body: o.text,
          status: 'claim', kind: o.kind, trust: 'agent', sourceKind: CONSOLIDATOR_SOURCE, sourceRef: ref, supersedes: null, contentHash: hash,
          staleAfter: now + PROPOSAL_TTL_MS, verifiedAt: null, now, sessionRef: ref, sourceEventId: src.sourceEventId,
        })
        appendMemoryEvent(memoryContext(db, now), id, CONSOLIDATOR_SOURCE, 'memory.consolidate.propose', { op: o.op, targetId: o.targetId, node: src.nodeId }, now)
      })
      out.written.push(id)
    } catch (err) {
      if (err instanceof MemoryRejectedError) out.skipped.push({ text: o.text, code: err.code })
      else if (err instanceof MemoryConflictError) out.skipped.push({ text: o.text, code: 'duplicate' })
      else throw err
    }
  }
  return out
}

function view(r: MemoryRecord, db: Database): ProposalView {
  const { op, targetId } = parseKey(r.key)
  const target = targetId === null ? null : getRow(db, `SELECT body FROM memory WHERE id = ? AND ${ACTIVE}`, targetId)
  return {
    id: r.id, op, kind: r.kind, text: redactSecrets(r.body), targetId, targetText: target === null ? null : redactSecrets(String(target['body'])),
    untrusted: r.trust === 'external', sourceEventId: r.sourceEventId, node: r.sourceRef?.startsWith('node:') ? r.sourceRef.slice(5) : null, createdAt: r.createdAt,
  }
}

/** Pending proposals, oldest first. */
export function listConsolidatorProposals(db: Database): ProposalView[] {
  return allRows(db, `SELECT * FROM memory WHERE ${PENDING} ORDER BY created_at, id LIMIT ?`, LIST_MAX).map((r) => view(toMemoryRecord(r), db))
}

/** A human accepts one proposal; returns the id of the memory it produced (or closed, for invalidate). */
export function confirmConsolidatorProposal(db: Database, authority: MemoryAuthority, id: string, now: number): { id: string; op: ConsolidationOp; resultId: string } {
  if (authority.kind !== 'human') throw new MemoryAuthorityError('confirmConsolidatorProposal: only a human may do this')
  return tx(memoryContext(db, now), () => {
    const row = getRow(db, `SELECT * FROM memory WHERE id = ? AND ${PENDING}`, id)
    if (row === null) throw new MemoryRejectedError('not_found', `consolidator proposal not found: ${id}`)
    const r = toMemoryRecord(row)
    if (r.trust === 'external') throw new MemoryRejectedError('untrusted_source', 'a proposal from an untrusted source cannot be confirmed')
    const { op, targetId } = parseKey(r.key)
    let resultId = r.id
    if (op === 'add' && r.kind === 'procedure') resultId = addProcedural(db, HUMAN_UI, r.body, now).id
    else if (op === 'add') {
      execWrite(db, "UPDATE memory SET status = 'fact', trust = 'human', verified_at = ?, valid_from = ?, stale_after = NULL, updated_at = ? WHERE id = ?", now, now, now, r.id)
    } else {
      const target = getRow(db, `SELECT * FROM memory WHERE id = ? AND ${ACTIVE}`, targetId)
      if (target === null) throw new MemoryRejectedError('target_gone', 'the memory this proposal changes no longer exists')
      if (op === 'update') resultId = editMemory(db, authority, String(target['id']), r.body, now).id
      else {
        supersedeRow(db, toMemoryRecord(target), now, null)
        resultId = String(target['id'])
        appendMemoryEvent(memoryContext(db, now), resultId, authority.id, 'memory.invalidate', { actorKind: authority.kind, proposal: r.id }, now)
      }
    }
    if (resultId !== r.id) supersedeRow(db, r, now, op === 'invalidate' ? null : resultId)
    appendMemoryEvent(memoryContext(db, now), r.id, authority.id, 'memory.consolidate.confirm', { op, resultId }, now)
    return { id: r.id, op, resultId }
  })
}

/** "Confirm all": every confirmable proposal, one at a time; failures are reported per item, not fatal. */
export function confirmAllConsolidatorProposals(db: Database, authority: MemoryAuthority, now: number): Array<{ id: string; ok: boolean; code?: string }> {
  return listConsolidatorProposals(db).filter((p) => !p.untrusted).map((p) => {
    try {
      confirmConsolidatorProposal(db, authority, p.id, now)
      return { id: p.id, ok: true }
    } catch (err) {
      if (err instanceof MemoryRejectedError) return { id: p.id, ok: false, code: err.code }
      throw err
    }
  })
}
