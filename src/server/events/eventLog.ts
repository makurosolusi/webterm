// Append-only, hash-chained Senses log over the ledger `event` table (schema v10).
// Only rows with a non-NULL `hash` belong to the chain; legacy ledger audit rows (hash NULL,
// written by ledger/ledgerEvent.ts) are ignored here. The DB handle is injected, so this module
// imports bun:sqlite types only.
import type { Database } from 'bun:sqlite'
import { allRows, execInsert, getRow, tx, type Row } from '../ledger/ledgerCore'
import { type EventBus } from './eventBus'
import {
  type AppendEventInput,
  type AppendResult,
  type ChainHead,
  type EventTrust,
  type HashedColumns,
  type SenseEvent,
  type VerifyResult,
  GENESIS_HASH,
  canonicalJson,
  chainHash,
} from './eventModel'

export const DEFAULT_DEDUPE_WINDOW_MS = 60_000
export const MAX_PAYLOAD_BYTES = 64 * 1024
const VERIFY_PAGE = 1000
const LIST_MAX = 500
const KIND_RE = /^[a-z][\w-]*(\.[\w-]+)+$/
const SOURCE_RE = /^[\w.:-]{1,64}$/

const SELECT_COLS =
  'seq, ts, kind, source, actor, subject, workspace_id, node_id, trust, dedupe_key, payload_json, prev_hash, hash'

export class EventLogError extends Error {}

function text(row: Row, key: string): string | null {
  const v = row[key]
  return v === null || v === undefined ? null : String(v)
}

function columnsOf(row: Row): HashedColumns {
  return {
    prev_hash: String(row['prev_hash']),
    ts: Number(row['ts']),
    kind: String(row['kind']),
    source: String(row['source']),
    actor: String(row['actor']),
    subject: text(row, 'subject'),
    workspace_id: text(row, 'workspace_id'),
    node_id: text(row, 'node_id'),
    trust: String(row['trust']),
    dedupe_key: text(row, 'dedupe_key'),
    payload_json: text(row, 'payload_json'),
  }
}

function toSenseEvent(row: Row): SenseEvent {
  const c = columnsOf(row)
  return {
    seq: Number(row['seq']),
    ts: c.ts,
    kind: c.kind,
    source: c.source,
    actor: c.actor,
    subject: c.subject,
    workspaceId: c.workspace_id,
    nodeId: c.node_id,
    trust: c.trust as EventTrust,
    dedupeKey: c.dedupe_key,
    payload: c.payload_json === null ? null : JSON.parse(c.payload_json),
    prevHash: c.prev_hash,
    hash: String(row['hash']),
  }
}

function requireMatch(value: unknown, re: RegExp, field: string): string {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new EventLogError(`appendEvent: invalid ${field} ${JSON.stringify(value)}`)
  }
  return value
}

function optionalText(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value === '' || value.length > 512) {
    throw new EventLogError(`appendEvent: ${field} must be a non-empty string of at most 512 chars`)
  }
  return value
}

export interface EventLogOptions {
  now?: () => number
  bus?: EventBus
  dedupeWindowMs?: number
  /** Called after every non-deduped append (the anchor writer hooks in here). */
  onAppend?: (event: SenseEvent) => void
}

export function createEventLog(db: Database, opts: EventLogOptions = {}) {
  const ctx = { db, now: opts.now ?? Date.now }
  const windowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS

  function head(): ChainHead | null {
    const row = getRow(db, 'SELECT seq, hash FROM event WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1')
    return row ? { seq: Number(row['seq']), hash: String(row['hash']) } : null
  }

  return {
    head,

    /**
     * Appends one chained event (BEGIN IMMEDIATE, so head read + insert are atomic) and then
     * publishes it on the bus. Joins an ambient transaction if the caller has one open; in that
     * case subscribers are notified before the outer COMMIT, so prefer calling it outside one.
     */
    append(input: AppendEventInput): AppendResult {
      const kind = requireMatch(input.kind, KIND_RE, 'kind')
      const source = requireMatch(input.source, SOURCE_RE, 'source')
      const actor = input.actor === undefined ? source : requireMatch(input.actor, SOURCE_RE, 'actor')
      if (input.trust !== 'trusted' && input.trust !== 'untrusted') {
        throw new EventLogError(`appendEvent: trust must be 'trusted' or 'untrusted', got ${JSON.stringify(input.trust)}`)
      }
      const ts = input.ts ?? ctx.now()
      if (!Number.isSafeInteger(ts)) throw new EventLogError(`appendEvent: ts must be an integer, got ${ts}`)
      let payloadJson: string | null = null
      if (input.payload !== undefined) {
        try {
          payloadJson = canonicalJson(input.payload)
        } catch (err) {
          throw new EventLogError(`appendEvent ${kind}: payload is not JSON-serialisable`, { cause: err })
        }
        if (Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
          throw new EventLogError(`appendEvent ${kind}: payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
        }
      }
      const base = {
        ts,
        kind,
        source,
        actor,
        subject: optionalText(input.subject, 'subject'),
        workspace_id: optionalText(input.workspaceId, 'workspaceId'),
        node_id: optionalText(input.nodeId, 'nodeId'),
        trust: input.trust,
        dedupe_key: optionalText(input.dedupeKey, 'dedupeKey'),
        payload_json: payloadJson,
      }
      const result = tx(ctx, (): { row: Row; deduped: boolean } => {
        if (base.dedupe_key !== null) {
          const dup = getRow(
            db,
            `SELECT ${SELECT_COLS} FROM event WHERE dedupe_key = ? AND hash IS NOT NULL AND ts >= ? ORDER BY seq DESC LIMIT 1`,
            base.dedupe_key,
            ts - windowMs
          )
          if (dup) return { row: dup, deduped: true }
        }
        const columns: HashedColumns = { prev_hash: head()?.hash ?? GENESIS_HASH, ...base }
        const seq = execInsert(
          db,
          `INSERT INTO event (ts, kind, source, actor, subject, workspace_id, node_id, trust, dedupe_key, payload_json, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          columns.ts, columns.kind, columns.source, columns.actor, columns.subject, columns.workspace_id,
          columns.node_id, columns.trust, columns.dedupe_key, columns.payload_json, columns.prev_hash, chainHash(columns)
        )
        const row = getRow(db, `SELECT ${SELECT_COLS} FROM event WHERE seq = ?`, seq)
        if (!row) throw new EventLogError(`appendEvent ${kind}: insert returned no row (seq=${seq})`)
        return { row, deduped: false }
      })
      const event = toSenseEvent(result.row)
      if (!result.deduped) {
        opts.bus?.publish(event)
        opts.onAppend?.(event)
      }
      return { event, deduped: result.deduped }
    },

    /** Chained events with seq > afterSeq, ascending; limit clamped to 500. */
    list(afterSeq = 0, limit = LIST_MAX): SenseEvent[] {
      const n = Math.max(1, Math.min(LIST_MAX, Math.trunc(limit)))
      return allRows(db, `SELECT ${SELECT_COLS} FROM event WHERE hash IS NOT NULL AND seq > ? ORDER BY seq ASC LIMIT ?`, afterSeq, n).map(toSenseEvent)
    },

    /** The hash stored for chained row `seq`, or null when that row is gone / not chained. */
    hashAt(seq: number): string | null {
      const row = getRow(db, 'SELECT hash FROM event WHERE seq = ? AND hash IS NOT NULL', seq)
      return row ? String(row['hash']) : null
    },

    /**
     * Walks the whole chain in pages and reports the first broken row: a row whose prev_hash is
     * not the previous row's hash (deleted/reordered/inserted row) or whose own hash does not
     * match its columns (edited row). Truncation of the newest rows is only visible against the
     * external anchor (eventAnchor.ts).
     */
    verifyChain(): VerifyResult {
      let expectedPrev = GENESIS_HASH
      let checked = 0
      let after = 0
      let last: ChainHead | null = null
      for (;;) {
        const rows = allRows(
          db,
          `SELECT ${SELECT_COLS} FROM event WHERE hash IS NOT NULL AND seq > ? ORDER BY seq ASC LIMIT ?`,
          after,
          VERIFY_PAGE
        )
        for (const row of rows) {
          const seq = Number(row['seq'])
          const columns = columnsOf(row)
          if (columns.prev_hash !== expectedPrev) {
            return { ok: false, checked, head: head(), brokenAt: { seq, reason: 'prev_hash_mismatch' } }
          }
          if (chainHash(columns) !== String(row['hash'])) {
            return { ok: false, checked, head: head(), brokenAt: { seq, reason: 'hash_mismatch' } }
          }
          expectedPrev = String(row['hash'])
          last = { seq, hash: expectedPrev }
          checked += 1
        }
        if (rows.length < VERIFY_PAGE) return { ok: true, checked, head: last }
        after = last?.seq ?? after
      }
    },
  }
}

export type EventLog = ReturnType<typeof createEventLog>
