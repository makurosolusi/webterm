// GET /api/node-status?ids=a,b — per node, what the status bar cannot derive from its stream: PTY pid
// and start, hook clocks, the current session's model / context / cost (`cost_usage`, captured from the
// transcript on each hook), outbox counts and the open Central delegation. Root token only (not in
// `isNodeTokenPath`). Bounded: at most NODE_STATUS_MAX_IDS ids, a fixed number of indexed queries each.
import type { Database } from 'bun:sqlite'
import { isSafeNodeId } from '../shared/workspace'
import type { AgentStatus } from '../shared/workspace'
import { NODE_STATUS_MAX_IDS, NODE_STATUS_PATH, type NodeStatusInfo } from '../shared/nodeStatusBar'
import { getRow } from './ledger/ledgerCore'
import { createWorkStore } from './central/work/workStore'

/** Claude's standard context window; a response that read more must be on the long window. */
export const CLAUDE_CONTEXT_TOKENS = 200_000
export const CLAUDE_LONG_CONTEXT_TOKENS = 1_000_000
const MICROS_PER_USD = 1_000_000
const MAX_MODEL_CHARS = 100
const MAX_TITLE_CHARS = 120

/** The slice of `sessions` this route reads. */
export interface NodeStatusSessions {
  ptyInfoOf(id: string): { pid: number; startedAt: number; cols: number; rows: number } | undefined
  statusEntryOf(id: string): { status: AgentStatus; updatedAt: number; since?: number } | undefined
  getExit(id: string): { code: number; reason: string; at: number } | undefined
}

export interface NodeStatusDeps {
  sessions(): NodeStatusSessions | Promise<NodeStatusSessions>
  /** Ledger DB; null (ledger off) = no cost, outbox or delegation fields. */
  db(): Database | null
}

type Result = { status: number; body: unknown } | null
const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v))

/** Used share of the window, 0..100. ponytail: the window is inferred from the count (usage rows do not
 *  carry it), so a 1M session below 200k reads high; record the window with the usage row to fix it. */
export function contextPercent(tokens: number): number {
  const window = tokens > CLAUDE_CONTEXT_TOKENS ? CLAUDE_LONG_CONTEXT_TOKENS : CLAUDE_CONTEXT_TOKENS
  return Math.min(100, Math.round((tokens / window) * 1000) / 10)
}

function costOf(db: Database, id: string): Pick<NodeStatusInfo, 'model' | 'contextPct' | 'costUsd'> {
  const last = getRow(db, `SELECT model, session_id, input, cache_read, cache_write_5m, cache_write_1h FROM cost_usage
    WHERE node_id = ? AND source = 'agent' ORDER BY ts DESC LIMIT 1`, id)
  if (!last) return {}
  const tokens = Number(last['input']) + Number(last['cache_read']) + Number(last['cache_write_5m']) + Number(last['cache_write_1h'])
  const spent = getRow(db, "SELECT COALESCE(SUM(cost_micros), 0) AS c FROM cost_usage WHERE node_id = ? AND source = 'agent' AND session_id IS ?", id, last['session_id'])
  return {
    ...(typeof last['model'] === 'string' ? { model: last['model'].slice(0, MAX_MODEL_CHARS) } : {}),
    contextPct: contextPercent(tokens),
    costUsd: Number(spent?.['c'] ?? 0) / MICROS_PER_USD,
  }
}

function outboxOf(db: Database, id: string): NodeStatusInfo['outbox'] {
  const q = getRow(db, "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM agent_outbox WHERE to_node = ? AND status = 'queued'", id)
  const s = getRow(db, `SELECT MAX(CASE WHEN status = 'failed' THEN settled_at END) AS f, MAX(CASE WHEN status = 'delivered' THEN settled_at END) AS d
    FROM agent_outbox WHERE to_node = ? AND status IN ('failed', 'delivered')`, id)
  const out = { queued: Number(q?.['n'] ?? 0), oldestQueuedAt: num(q?.['oldest']), lastFailedAt: num(s?.['f']), lastDeliveredAt: num(s?.['d']) }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as NodeStatusInfo['outbox']
}

function workOf(db: Database, id: string): NodeStatusInfo['work'] {
  const store = createWorkStore(db, Date.now)
  const a = store.openAssignmentOfNode(id)
  const task = a && store.getTask(a.taskId)
  return task ? { title: task.title.slice(0, MAX_TITLE_CHARS), status: task.status, startedAt: a.startedAt } : undefined
}

/** One node's facts. */
export function nodeStatusOf(id: string, s: NodeStatusSessions, db: Database | null): NodeStatusInfo {
  const pty = s.ptyInfoOf(id)
  const st = s.statusEntryOf(id)
  const exit = pty ? undefined : s.getExit(id)
  const work = db ? workOf(db, id) : undefined
  return {
    live: !!pty,
    ...(pty ? { pid: pty.pid, startedAt: pty.startedAt } : {}),
    ...(exit ? { exit: { code: exit.code, reason: exit.reason, at: exit.at } } : {}),
    ...(st ? { status: st.status, lastHookAt: st.updatedAt, ...(st.since !== undefined ? { statusSince: st.since } : {}) } : {}),
    ...(db ? { ...costOf(db, id), outbox: outboxOf(db, id) } : {}),
    ...(work ? { work } : {}),
  }
}

export async function nodeStatusRoute(path: string, method: string, query: URLSearchParams, deps: NodeStatusDeps): Promise<Result> {
  if (path !== NODE_STATUS_PATH) return null
  if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
  const ids = (query.get('ids') ?? '').split(',').filter(Boolean)
  if (ids.length === 0 || ids.length > NODE_STATUS_MAX_IDS || !ids.every((id) => isSafeNodeId(id))) {
    return { status: 400, body: { error: 'bad_request', message: `ids: 1..${NODE_STATUS_MAX_IDS} node ids, comma-separated` } }
  }
  const s = await deps.sessions()
  const db = deps.db()
  return { status: 200, body: { nodes: Object.fromEntries(ids.map((id) => [id, nodeStatusOf(id, s, db)])) } }
}
