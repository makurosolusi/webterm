// Usage capture: Claude Code transcripts of agent nodes (read-only, incremental by byte offset),
// finished Central turns, and Central's `claude -p` helpers. Each new response goes to `cost_usage`, is
// mirrored into the ledger `run`/`usage` tables when its workspace has a ledger project (the brief and
// checkBudget read those), and Central turns also feed the guard's daily `central_budget` counters.
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getRow, allRows } from '../ledger/ledgerCore'
import { projectRepository } from '../ledger/ledgerEntity'
import { getRun, recordUsage, startRun } from '../ledger/ledgerUsage'
import { lookupWorkspace } from '../central/workspaceLookup'
import { addUsage, guardTokens } from '../central/guard/budgetStore'
import { transcriptPathAllowed } from '../transcriptPath'
import { costMicros } from './costPricing'
import { parseTranscriptUsage } from './costTranscript'
import { ensureCostSchema, insertCostUsage, type CostUsageRow } from './costStore'
import { workerTier } from './costTier'

/** Bytes read per file per capture; the rest is picked up by the next hook. */
const READ_CAP = 8 * 1024 * 1024
/** Central turns synced per call; a backlog drains over several calls. */
const TURN_BATCH = 500
const CENTRAL_PROJECT_PREFIX = 'central:project:'
const CENTRAL_TURN_KEY = 'central-turn:'

// ponytail: offsets live in memory; after a restart files are re-read from 0 and dedupe by message id.
const offsets = new Map<string, number>()

/** Complete new lines of `path` since the last read (empty when nothing new). */
function readNew(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let from = offsets.get(path) ?? 0
    if (size < from) from = 0
    const len = Math.min(size - from, READ_CAP)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, from)
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return ''
    offsets.set(path, from + end + 1)
    return buf.subarray(0, end).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The main transcript plus its subagent transcripts (`<session>/subagents/*.jsonl`). */
function transcriptFiles(path: string): string[] {
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents')
  const subs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) : []
  return [path, ...subs]
}

/** Ledger project for a workspace: existing row, else created from the workspace store, else null. */
function ledgerProject(db: Database, workspaceId: string | null, now: () => number): string | null {
  if (!workspaceId) return null
  const row = getRow(db, 'SELECT id FROM project WHERE id = ? OR workspace_id = ?', workspaceId, workspaceId)
  if (row) return String(row['id'])
  const ws = lookupWorkspace(workspaceId)
  if (!ws) return null
  return projectRepository({ db, now }).createProject({ id: workspaceId, workspaceId, name: ws.name, path: ws.cwd || homedir() }).id
}

function mirror(db: Database, projectId: string | null, runId: string, route: string, r: CostUsageRow, now: () => number): void {
  if (!projectId) return
  const ctx = { db, now }
  if (!getRun(ctx, runId)) startRun(ctx, { id: runId, projectId, depth: 0, provider: 'anthropic', route, startedAt: r.ts, ...(r.model ? { model: r.model } : {}) })
  recordUsage(ctx, {
    runId, providerResponseId: r.key, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead,
    cacheWriteTokens: r.write5m + r.write1h, ts: r.ts, priceKnown: r.costMicros !== null, ...(r.costMicros === null ? {} : { costMicros: r.costMicros }),
  })
}

export interface NodeTranscript { path: string; nodeId: string; workspaceId: string | null }

/** Reads what is new in a node's transcripts; returns how many responses were new. */
export function captureTranscript(db: Database, t: NodeTranscript, now: () => number = Date.now): number {
  ensureCostSchema(db)
  if (!transcriptPathAllowed(t.path) || !existsSync(t.path)) return 0
  let added = 0
  for (const file of transcriptFiles(t.path)) {
    for (const u of parseTranscriptUsage(readNew(file))) {
      const row: CostUsageRow = {
        key: `cc:${u.messageId}`, ts: u.ts || now(), source: 'agent', workspaceId: t.workspaceId, nodeId: t.nodeId,
        sessionId: u.sessionId, model: u.model, input: u.input, output: u.output, cacheRead: u.cacheRead,
        write5m: u.write5m, write1h: u.write1h, costMicros: costMicros(u.model, u),
      }
      row.tier = workerTier(db, t.nodeId, row.ts)
      if (!insertCostUsage(db, row)) continue
      added++
      mirror(db, ledgerProject(db, t.workspaceId, now), `cc:${u.sessionId ?? t.path}`, 'claude-code', row, now)
    }
  }
  return added
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0)

/** Finished Central turns not yet recorded. Their cost is the runtime's own estimate (`total_cost_usd`). */
export function syncCentralTurns(db: Database, now: () => number = Date.now): number {
  ensureCostSchema(db)
  // Keyed on turn rows only: other `central` rows (older consolidator bookings) must not move the mark past unsynced turns.
  const mark = Number(getRow(db, "SELECT COALESCE(MAX(ts), 0) AS m FROM cost_usage WHERE source = 'central' AND substr(key, 1, ?) = ?",
    CENTRAL_TURN_KEY.length, CENTRAL_TURN_KEY)?.['m'] ?? 0)
  const rows = allRows(db, `SELECT id, conversation_id, runtime, usage_json, ended_at FROM central_turn
    WHERE ended_at IS NOT NULL AND usage_json IS NOT NULL AND ended_at >= ? ORDER BY ended_at ASC LIMIT ?`, mark, TURN_BATCH)
  let added = 0
  for (const t of rows) {
    let u: Record<string, unknown>
    try { u = JSON.parse(String(t['usage_json'])) as Record<string, unknown> } catch { continue }
    const conv = String(t['conversation_id'])
    const projectId = conv.startsWith(CENTRAL_PROJECT_PREFIX) ? conv.slice(CENTRAL_PROJECT_PREFIX.length) : null
    const project = projectId ? getRow(db, 'SELECT id, workspace_id FROM project WHERE id = ?', projectId) : null
    const ts = Number(t['ended_at'])
    // The real model id when the runtime reported one (`modelUsage`); older turns keep the runtime kind.
    const model = typeof u.model === 'string' && u.model !== '' ? u.model : t['runtime'] == null ? null : `central:${String(t['runtime'])}`
    const tokens = { input: n(u.inputTokens), output: n(u.outputTokens), cacheRead: n(u.cacheReadTokens), write5m: n(u.cacheWriteTokens), write1h: 0 }
    const runtimeCost = n(u.costMicros)
    const cost = runtimeCost > 0 ? runtimeCost : costMicros(model, tokens)
    const row: CostUsageRow = {
      key: `${CENTRAL_TURN_KEY}${String(t['id'])}`, ts, source: 'central', workspaceId: project ? String(project['workspace_id']) : null,
      nodeId: null, sessionId: null, model, ...tokens, costMicros: cost,
    }
    if (!insertCostUsage(db, row)) continue
    added++
    mirror(db, project ? String(project['id']) : null, row.key, 'central', row, now)
    // The guard's daily token/cost limits count Central's own turns, on the day the turn ended.
    addUsage(db, {
      turns: 1, tokens: guardTokens({ input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.write5m + row.write1h }),
      costMicros: cost ?? 0, spawns: 0, wallMs: n(u.durationMs), projectId: project ? String(project['id']) : null,
    }, () => ts)
  }
  return added
}

/** Central's `claude -p` helpers (and the provider's Test connection request); each is its own `session_id` under source `helper`. */
export type HelperKind = 'classifier' | 'checkpoint' | 'handoff' | 'brief' | 'consolidator' | 'health_analysis' | 'connection_test' | 'page_reader'
/** One helper answer's usage: tokens, the CLI's cost estimate (null = unknown) and the model that ran. */
export interface HelperUsage { input: number; output: number; cacheRead: number; cacheWrite: number; costMicros: number | null; model: string | null }

/**
 * Books one helper call (key `<kind>:<id>`); true when new. Without the CLI's cost estimate the row is
 * priced from the table. Helpers stay out of `central_budget`: that guard counts Central's own turns.
 */
export function recordHelperUsage(db: Database, kind: HelperKind, u: HelperUsage, opts: { id?: string; nodeId?: string | null; now?: () => number } = {}): boolean {
  ensureCostSchema(db)
  const tokens = { input: u.input, output: u.output, cacheRead: u.cacheRead, write5m: u.cacheWrite, write1h: 0 }
  return insertCostUsage(db, {
    key: `${kind}:${opts.id ?? randomUUID()}`, ts: (opts.now ?? Date.now)(), source: 'helper', workspaceId: null, nodeId: opts.nodeId ?? null,
    sessionId: kind, model: u.model, ...tokens, costMicros: u.costMicros ?? costMicros(u.model, tokens),
  })
}
