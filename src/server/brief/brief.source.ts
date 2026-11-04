// Reads what the morning brief is built from: chained events since `since`, the current Inbox
// counts and the usage ledger. SQL only; the wording lives in ./brief.model.
import type { Database } from 'bun:sqlite'
import { allRows, getRow } from '../ledger/ledgerCore'
import { inboxCounts } from '../inbox'
import { BRIEF_KINDS, type BriefEvent, type BriefUsage } from './brief.model'

/** Most events one brief reads; a week of fs/hook chatter stays far below it. */
export const BRIEF_EVENT_CAP = 20_000

export interface BriefSource {
  events: BriefEvent[]
  headSeq: number
  inbox: { needsYou: number; review: number } | null
  usage: BriefUsage | null
}

function parse(json: unknown): unknown {
  if (typeof json !== 'string') return null
  try { return JSON.parse(json) } catch { return null }
}

/** Highest chained seq (the brief's cache key); 0 for an empty log. */
export function headSeq(db: Database): number {
  return Number(getRow(db, 'SELECT MAX(seq) AS s FROM event WHERE hash IS NOT NULL')?.['s'] ?? 0)
}

export function readBriefSource(db: Database, since: number, now: number): BriefSource {
  const kinds = BRIEF_KINDS.map(() => '?').join(',')
  // ponytail: no index on event(ts), so this is a scan; add one in a ledger migration if briefs get slow.
  const events = allRows(
    db,
    `SELECT ts, kind, node_id, workspace_id, payload_json FROM event
     WHERE hash IS NOT NULL AND ts > ? AND (kind LIKE 'hook.%' OR kind IN (${kinds}))
     ORDER BY seq ASC LIMIT ?`,
    since, ...BRIEF_KINDS, BRIEF_EVENT_CAP,
  ).map((r): BriefEvent => ({
    ts: Number(r['ts']),
    kind: String(r['kind']),
    nodeId: r['node_id'] == null ? null : String(r['node_id']),
    workspaceId: r['workspace_id'] == null ? null : String(r['workspace_id']),
    payload: parse(r['payload_json']),
  }))
  const counts = inboxCounts(db, undefined, { now })
  const u = getRow(
    db,
    `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
       COALESCE(SUM(cost_micros), 0) AS c, COALESCE(SUM(CASE WHEN price_known = 0 OR cost_micros IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
     FROM usage WHERE ts > ?`,
    since,
  )
  const usage: BriefUsage | null = u
    ? { calls: Number(u['calls']), inputTokens: Number(u['i']), outputTokens: Number(u['o']), costMicros: Number(u['c']), unpriced: Number(u['unpriced']) }
    : null
  return { events, headSeq: headSeq(db), inbox: { needsYou: counts.needsYou, review: counts.review }, usage }
}
