/**
 * Write-time guard every memory insert goes through (F5-a): PII masking, tombstones, incognito
 * sessions and the poisoning rule. One choke point, so a future consolidator or importer gets the
 * same rules for free instead of re-implementing them.
 *
 * - Tombstone (ChatGPT "forget" with propagation, PLAN/rnd/03 §5): a forgotten text is matched by
 *   its normalized hash + subject (project id, '' = everywhere), so re-consolidation of an old
 *   transcript or a stale file import cannot resurrect it.
 * - Incognito: a session ref (`node:<id>` or a Central conversation id) on the list writes nothing.
 * - Poisoning (PLAN/rnd/03 §1 "Memory poisoning"): `external` trust (browser/web/agent output marked
 *   untrusted) may only ever be a `claim`, never a fact of any kind.
 */
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { execWrite, getRow } from '../ledger/ledgerCore'
import { maskPii } from './memoryPii'
import { MemoryRejectedError, type MemoryTrust } from './memoryModel'

/** sha256 of the body reduced to lowercase letters/digits separated by single spaces. */
export function normalizedTextHash(body: string): string {
  const norm = body.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return createHash('sha256').update(norm).digest('hex')
}

/** Tombstone subject of a row: its project, or '' for project-less memory (blocks the text everywhere). */
export const tombstoneSubject = (projectId: string | null): string => projectId ?? ''

export function isTombstoned(db: Database, projectId: string | null, body: string): boolean {
  return getRow(db, 'SELECT 1 AS one FROM memory_tombstone WHERE text_hash = ? AND subject IN (?, ?) LIMIT 1',
    normalizedTextHash(body), '', tombstoneSubject(projectId)) !== null
}

export function isIncognito(db: Database, refs: ReadonlyArray<string | null | undefined>): boolean {
  const list = refs.filter((r): r is string => typeof r === 'string' && r !== '')
  if (list.length === 0) return false
  return getRow(db, `SELECT 1 AS one FROM memory_incognito WHERE ref IN (${list.map(() => '?').join(',')}) LIMIT 1`, ...list) !== null
}

export interface GuardInput {
  projectId: string | null
  title: string
  body: string
  status: string
  trust: MemoryTrust
  /** Refs of the session that produced the write: source ref, conversation id, `node:<id>`. */
  refs: ReadonlyArray<string | null | undefined>
  /** Senses event the content came from; an `untrusted` event (browser/web, PLAN S3) taints it `external`. */
  sourceEventId?: number | null
}

/** True when the Senses event exists and is labelled untrusted. */
export function eventIsUntrusted(db: Database, seq: number | null | undefined): boolean {
  if (seq === null || seq === undefined) return false
  return getRow(db, "SELECT 1 AS one FROM event WHERE seq = ? AND trust = 'untrusted'", seq) !== null
}

/** A human deliberately re-adds a text they once forgot: the tombstone for that text goes. */
export function liftTombstone(db: Database, projectId: string | null, body: string): void {
  execWrite(db, 'DELETE FROM memory_tombstone WHERE text_hash = ? AND subject IN (?, ?)',
    normalizedTextHash(maskPii(body)), '', tombstoneSubject(projectId))
}

export interface GuardedWrite { title: string; body: string; trust: MemoryTrust }

/** Masked title/body and effective trust ready to hash and store; throws a coded `MemoryRejectedError` when refused. */
export function guardMemoryWrite(db: Database, input: GuardInput): GuardedWrite {
  const trust: MemoryTrust = eventIsUntrusted(db, input.sourceEventId) ? 'external' : input.trust
  if (trust === 'external' && input.status !== 'claim') {
    throw new MemoryRejectedError('untrusted_source', 'untrusted (external) content can only be stored as a claim')
  }
  if (isIncognito(db, input.refs)) throw new MemoryRejectedError('incognito', 'this session is incognito: nothing is remembered')
  const title = maskPii(input.title)
  const body = maskPii(input.body)
  if (isTombstoned(db, input.projectId, body)) throw new MemoryRejectedError('forgotten', 'the user asked to forget this memory')
  return { title, body, trust }
}
