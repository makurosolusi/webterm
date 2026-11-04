// Cost tables in the ledger DB: one row per billed response (`cost_usage`), one per routine run /
// DAG task (`cost_run`, a time window on a node), and caps/pauses (`cost_cap`). Module-owned like
// knowledgeStore: additive `IF NOT EXISTS` DDL, nothing to backfill, so it needs no ledger version.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow } from '../ledger/ledgerCore'

const DDL = `
CREATE TABLE IF NOT EXISTS cost_usage (
  key TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL,
  workspace_id TEXT, node_id TEXT, session_id TEXT, model TEXT,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  cost_micros INTEGER, price_known INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_usage_ts ON cost_usage(ts);
CREATE INDEX IF NOT EXISTS idx_cost_usage_node_ts ON cost_usage(node_id, ts);
CREATE TABLE IF NOT EXISTS cost_run (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('routine','dag')), ref TEXT NOT NULL, label TEXT,
  workspace_id TEXT, node_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  produced_diff INTEGER, cost_micros INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cost_run_ref ON cost_run(kind, ref, ended_at);
CREATE TABLE IF NOT EXISTS cost_cap (
  scope TEXT PRIMARY KEY, limit_micros INTEGER NOT NULL DEFAULT 0, paused_at INTEGER, reason TEXT
);
`

const ready = new WeakSet<Database>()

/** Idempotent; every entry point calls it, so a fresh ledger gets the tables on first use. */
export function ensureCostSchema(db: Database): void {
  if (ready.has(db)) return
  db.exec(DDL)
  ready.add(db)
}

export interface CostUsageRow {
  key: string
  ts: number
  source: 'agent' | 'central'
  workspaceId: string | null
  nodeId: string | null
  sessionId: string | null
  model: string | null
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
  costMicros: number | null
}

/** True when the row is new. A re-read of a still-streaming response keeps the larger output count. */
export function insertCostUsage(db: Database, r: CostUsageRow): boolean {
  ensureCostSchema(db)
  const before = getRow(db, 'SELECT output FROM cost_usage WHERE key = ?', r.key)
  if (before) {
    if (r.output > Number(before['output'])) execWrite(db, 'UPDATE cost_usage SET output = ?, cost_micros = ? WHERE key = ?', r.output, r.costMicros, r.key)
    return false
  }
  execWrite(db, `INSERT INTO cost_usage (key, ts, source, workspace_id, node_id, session_id, model, input, output, cache_read,
    cache_write_5m, cache_write_1h, cost_micros, price_known) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  r.key, r.ts, r.source, r.workspaceId, r.nodeId, r.sessionId, r.model, r.input, r.output, r.cacheRead,
  r.write5m, r.write1h, r.costMicros, r.costMicros === null ? 0 : 1)
  return true
}

/** Filter for `spent`; all fields optional and ANDed. `until` is exclusive. */
export interface SpendFilter { since: number; until?: number; workspaceId?: string; nodeId?: string; source?: 'agent' | 'central' }

function where(f: SpendFilter): { sql: string; args: unknown[] } {
  const parts = ['ts >= ?']
  const args: unknown[] = [f.since]
  if (f.until !== undefined) { parts.push('ts < ?'); args.push(f.until) }
  if (f.workspaceId) { parts.push('workspace_id = ?'); args.push(f.workspaceId) }
  if (f.nodeId) { parts.push('node_id = ?'); args.push(f.nodeId) }
  if (f.source) { parts.push('source = ?'); args.push(f.source) }
  return { sql: parts.join(' AND '), args }
}

/** Priced spend in micro-USD; `unpriced` counts responses whose model has no price. */
export function spentMicros(db: Database, f: SpendFilter): { costMicros: number; unpriced: number } {
  ensureCostSchema(db)
  const w = where(f)
  const r = getRow(db, `SELECT COALESCE(SUM(cost_micros), 0) AS c, COALESCE(SUM(1 - price_known), 0) AS u FROM cost_usage WHERE ${w.sql}`, ...w.args)
  return { costMicros: Number(r?.['c'] ?? 0), unpriced: Number(r?.['u'] ?? 0) }
}

export interface SpendGroup { key: string; costMicros: number; tokens: number; responses: number }

export interface SpendSummary {
  since: number
  costMicros: number
  unpriced: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** cacheRead / all input-side tokens; null with no traffic. */
  cacheHitRate: number | null
  byWorkspace: SpendGroup[]
  byNode: SpendGroup[]
  byModel: SpendGroup[]
  byRoutine: SpendGroup[]
}

const GROUP_LIMIT = 10

function groupBy(db: Database, column: string, since: number): SpendGroup[] {
  return allRows(db, `SELECT COALESCE(${column}, '') AS k, COALESCE(SUM(cost_micros), 0) AS c,
    SUM(input + output + cache_read + cache_write_5m + cache_write_1h) AS t, COUNT(*) AS n
    FROM cost_usage WHERE ts >= ? GROUP BY k ORDER BY c DESC, t DESC LIMIT ?`, since, GROUP_LIMIT)
    .map((r) => ({ key: String(r['k']), costMicros: Number(r['c']), tokens: Number(r['t']), responses: Number(r['n']) }))
}

/** Totals and top spenders since `since` (groups capped at 10, sorted by cost). */
export function spendSummary(db: Database, since: number): SpendSummary {
  ensureCostSchema(db)
  const t = getRow(db, `SELECT COALESCE(SUM(cost_micros), 0) AS c, COALESCE(SUM(1 - price_known), 0) AS u,
    COALESCE(SUM(input), 0) AS i, COALESCE(SUM(output), 0) AS o, COALESCE(SUM(cache_read), 0) AS r,
    COALESCE(SUM(cache_write_5m + cache_write_1h), 0) AS w FROM cost_usage WHERE ts >= ?`, since)
  const input = Number(t?.['i'] ?? 0)
  const cacheRead = Number(t?.['r'] ?? 0)
  const cacheWrite = Number(t?.['w'] ?? 0)
  const inputSide = input + cacheRead + cacheWrite
  const byRoutine = allRows(db, `SELECT kind || ':' || ref AS k, COALESCE(SUM(cost_micros), 0) AS c, COUNT(*) AS n
    FROM cost_run WHERE started_at >= ? GROUP BY k ORDER BY c DESC LIMIT ?`, since, GROUP_LIMIT)
    .map((r) => ({ key: String(r['k']), costMicros: Number(r['c']), tokens: 0, responses: Number(r['n']) }))
  return {
    since, costMicros: Number(t?.['c'] ?? 0), unpriced: Number(t?.['u'] ?? 0),
    input, output: Number(t?.['o'] ?? 0), cacheRead, cacheWrite,
    cacheHitRate: inputSide > 0 ? cacheRead / inputSide : null,
    byWorkspace: groupBy(db, 'workspace_id', since),
    byNode: groupBy(db, 'node_id', since),
    byModel: groupBy(db, 'model', since),
    byRoutine,
  }
}
