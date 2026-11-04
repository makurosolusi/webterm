// Replay sources: bounded reads of the Senses event log, the cost table and Claude transcripts for
// one scope (a node, or a whole workspace) and time range. Every read is keyset-paginated after a
// cursor and capped at `limit + 1` rows, so a page never loads a whole table into memory.
import type { Database } from 'bun:sqlite'
import { allRows, type Row } from '../ledger/ledgerCore'
import { linesFromClaude } from '../contextLinkTranscript'
import type { SenseEvent } from '../events/eventModel'
import {
  APPROVAL_KINDS, SOURCE_RANK, afterCursor, eventItem, transcriptItem,
  type Cursor, type ReplayItem, type SourceName,
} from './replay.model'

export interface ReplayScope {
  workspaceId: string
  /** One node, or null for the whole workspace. */
  nodeId: string | null
  /** Node ids on the workspace board (events without workspace_id are matched by node). */
  nodeIds: readonly string[]
}

export interface ReplayRange { from: number; to: number }

/** SQL + args for "after cursor" on a source of rank `rank` whose id column is `idCol`. */
function cursorSql(c: Cursor | null, source: SourceName, idCol: string): { sql: string; args: unknown[] } {
  if (!c) return { sql: '1', args: [] }
  const r = SOURCE_RANK[source]
  if (r > c.rank) return { sql: 'ts >= ?', args: [c.ts] }
  if (r < c.rank) return { sql: 'ts > ?', args: [c.ts] }
  return { sql: `(ts > ? OR (ts = ? AND ${idCol} > ?))`, args: [c.ts, c.ts, c.id] }
}

function scopeSql(s: ReplayScope): { sql: string; args: unknown[] } {
  if (s.nodeId) return { sql: 'node_id = ?', args: [s.nodeId] }
  return { sql: '(workspace_id = ? OR node_id IN (SELECT value FROM json_each(?)))', args: [s.workspaceId, JSON.stringify(s.nodeIds)] }
}

// Mirrors `laneOf`: everything here maps to a lane, so a page is never short of lane items.
// `policy.decision` allows are the bulk of that kind and say nothing a reviewer needs; only ask/deny.
const KIND_SQL = `(kind LIKE 'hook.%' OR kind LIKE 'checkpoint.%' OR kind IN ('fs.change', 'mcp.call', ${APPROVAL_KINDS.filter((k) => k !== 'policy.decision').map((k) => `'${k}'`).join(', ')})
  OR (kind = 'policy.decision' AND COALESCE(json_extract(payload_json, '$.effect'), '') <> 'allow'))`

const EVENT_COLS = 'seq, ts, kind, source, actor, subject, workspace_id, node_id, trust, dedupe_key, payload_json, prev_hash, hash'

function senseEvent(r: Row): SenseEvent {
  const s = (k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]))
  return {
    seq: Number(r['seq']), ts: Number(r['ts']), kind: String(r['kind']), source: String(r['source']), actor: String(r['actor']),
    subject: s('subject'), workspaceId: s('workspace_id'), nodeId: s('node_id'), trust: r['trust'] === 'untrusted' ? 'untrusted' : 'trusted',
    dedupeKey: s('dedupe_key'), payload: r['payload_json'] === null ? null : JSON.parse(String(r['payload_json'])), prevHash: String(r['prev_hash']), hash: String(r['hash']),
  }
}

// ponytail: no index on event(ts)/event(node_id) yet, so this scans the chained rows of the range;
// add `CREATE INDEX idx_event_ts ON event(ts, seq)` in a ledger migration when replay gets slow.
export function eventItems(db: Database, s: ReplayScope, r: ReplayRange, c: Cursor | null, limit: number): ReplayItem[] {
  const sc = scopeSql(s)
  const cu = cursorSql(c, 'event', 'seq')
  const rows = allRows(
    db,
    `SELECT ${EVENT_COLS} FROM event WHERE hash IS NOT NULL AND ts >= ? AND ts < ? AND ${sc.sql} AND ${KIND_SQL} AND ${cu.sql} ORDER BY ts ASC, seq ASC LIMIT ?`,
    r.from, r.to, ...sc.args, ...cu.args, limit + 1,
  )
  return rows.flatMap((row) => { const i = eventItem(senseEvent(row)); return i ? [i] : [] })
}

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`

export function costItems(db: Database, s: ReplayScope, r: ReplayRange, c: Cursor | null, limit: number): ReplayItem[] {
  const sc = scopeSql(s)
  const cu = cursorSql(c, 'cost', 'rowid')
  const rows = allRows(
    db,
    `SELECT rowid AS id, ts, node_id, model, input, output, cost_micros FROM cost_usage WHERE ts >= ? AND ts < ? AND ${sc.sql} AND ${cu.sql} ORDER BY ts ASC, rowid ASC LIMIT ?`,
    r.from, r.to, ...sc.args, ...cu.args, limit + 1,
  )
  return rows.map((row) => {
    const micros = row['cost_micros'] === null ? 0 : Number(row['cost_micros'])
    const tokens = Number(row['input']) + Number(row['output'])
    const priced = row['cost_micros'] !== null
    return {
      key: `cost:${Number(row['id'])}`, source: 'cost', id: Number(row['id']), ts: Number(row['ts']), lane: 'cost',
      nodeId: row['node_id'] === null ? null : String(row['node_id']), costMicros: micros,
      text: `${priced ? usd(micros) : 'Unpriced'} · ${tokens} tokens${row['model'] ? ` · ${String(row['model'])}` : ''}`,
    }
  })
}

export interface TranscriptEntry { ts: number; nodeId: string; lines: string[] }

/** Claude JSONL -> timestamped rendered turns (lines without a `timestamp` or text are skipped). */
export function parseTranscript(nodeId: string, raw: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ts = Number.NaN
    try { ts = Date.parse(String((JSON.parse(line) as { timestamp?: unknown }).timestamp)) } catch { continue } // partial last line while the agent writes
    const lines = linesFromClaude(line)
    if (Number.isFinite(ts) && lines.length) out.push({ ts, nodeId, lines })
  }
  return out
}

/** Per-node transcripts -> lane items. id = nodeOrdinal * 1024 + index within the same ms (stable keyset). */
export function transcriptItems(byNode: ReadonlyArray<{ nodeId: string; entries: readonly TranscriptEntry[] }>, r: ReplayRange, c: Cursor | null, limit: number): ReplayItem[] {
  const out: ReplayItem[] = []
  const ordered = [...byNode].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  ordered.forEach(({ nodeId, entries }, ordinal) => {
    let lastTs = -1
    let dup = 0
    for (const e of entries) {
      dup = e.ts === lastTs ? dup + 1 : 0
      lastTs = e.ts
      if (e.ts < r.from || e.ts >= r.to || dup >= 1024) continue
      const item = transcriptItem(nodeId, ordinal * 1024 + dup, e.ts, e.lines)
      if (afterCursor(item, c)) out.push(item)
    }
  })
  return out.sort((a, b) => a.ts - b.ts || a.id - b.id).slice(0, limit + 1)
}
