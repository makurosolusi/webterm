// The ledger retention registry (data-209-10, agent-211-C4): every ledger table maps to exactly one
// policy — a batched sweep, a cascade from a swept parent, or an exemption with its reason. The
// policy test (ledgerRetention.policy.bun.test.ts) fails when a table in the live schema has none.
//
// Every sweep deletes at most `limit` rows per call (`rowid IN (SELECT ... LIMIT ?)`), only rows in
// a settled end state past their age, and never a row something open still points at.
import { TURN_STATUSES, isActiveTurnStatus } from '../central/conversationModel'
import { execWrite, type LedgerContext } from './ledgerCore'
import { pruneEventChain } from './ledgerRetentionEvent'

const DAY_MS = 24 * 60 * 60 * 1000
/** Settled work rows (outbox, inbox, approvals, dags, chat replay events) are kept this long. */
export const SETTLED_RETENTION_MS = 30 * DAY_MS
/** Spend history is kept a little over a year, so a year-on-year view still has data. */
export const USAGE_RETENTION_MS = 400 * DAY_MS
/** A settled approval keeps its tool input (≤ 32 KB) this long for the history view, then it is blanked. */
export const APPROVAL_INPUT_GRACE_MS = DAY_MS

export type Sweep = (ctx: LedgerContext, now: number, limit: number) => number

export type RetentionEntry =
  | { kind: 'sweep'; rule: string; sweep: Sweep }
  | { kind: 'cascade'; parent: string; rule: string }
  | { kind: 'exempt'; reason: string }

const TERMINAL_TURNS = TURN_STATUSES.filter((s) => !isActiveTurnStatus(s)).map((s) => `'${s}'`).join(', ')

/** Deletes at most `limit` rows of `table` matching `where` (table names are constants, never input). */
function deleteBatch(ctx: LedgerContext, table: string, where: string, limit: number, ...args: unknown[]): number {
  return execWrite(ctx.db, `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`, ...args, limit)
}

/** An approval that is decided and can no longer be consumed: rejected, expired, or approved and spent/expired. */
const SETTLED_APPROVAL = `a.status != 'pending' AND NOT (a.status = 'approved' AND (a.expires_at IS NULL OR a.expires_at > ?)
  AND EXISTS (SELECT 1 FROM decision d WHERE d.id = a.decision_id AND d.single_use = 1))`

const approvalSweep: Sweep = (ctx, now, limit) => {
  const blanked = execWrite(ctx.db, `UPDATE approval SET request_json = json_remove(request_json, '$.input')
    WHERE rowid IN (SELECT a.rowid FROM approval a WHERE ${SETTLED_APPROVAL} AND a.updated_at < ?
      AND json_type(a.request_json, '$.input') IS NOT NULL LIMIT ?)`, now, now - APPROVAL_INPUT_GRACE_MS, limit)
  const deleted = execWrite(ctx.db, `DELETE FROM approval WHERE rowid IN (SELECT a.rowid FROM approval a
    WHERE ${SETTLED_APPROVAL} AND a.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM inbox_item i WHERE i.approval_id = a.id AND i.status = 'open')
      AND NOT EXISTS (SELECT 1 FROM dag_gate g JOIN dag ON dag.id = g.dag_id WHERE g.approval_id = a.id AND dag.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM central_agents c WHERE c.approval_id = a.id AND c.ended_at IS NULL)
    LIMIT ?)`, now, now - SETTLED_RETENTION_MS, limit)
  return Math.max(blanked, deleted)
}

const sweep = (rule: string, fn: Sweep): RetentionEntry => ({ kind: 'sweep', rule, sweep: fn })
const exempt = (reason: string): RetentionEntry => ({ kind: 'exempt', reason })
const PROJECT_SCOPED = 'project-scoped state, deleted with its project (ledger.deleteProject cascade)'
const FTS_SHADOW = 'FTS5 shadow table, follows memory (rows go when memory rows go)'

/** Run order matters: approvals before decisions (orphans), dags before their cost runs. */
export const RETENTION: Record<string, RetentionEntry> = {
  event: sweep('chained rows past 30 days or past 200k rows, prefix only (chain stays verifiable)', (ctx, now, limit) => pruneEventChain(ctx, now, limit)),
  agent_outbox: sweep('settled (not queued) and settled 30+ days ago', (ctx, now, limit) =>
    deleteBatch(ctx, 'agent_outbox', "status != 'queued' AND settled_at IS NOT NULL AND settled_at < ?", limit, now - SETTLED_RETENTION_MS)),
  inbox_item: sweep('resolved (not open) 30+ days ago and its approval is no longer pending', (ctx, now, limit) =>
    deleteBatch(ctx, 'inbox_item', `status != 'open' AND updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.id = inbox_item.approval_id AND a.status = 'pending')`, limit, now - SETTLED_RETENTION_MS)),
  approval: sweep('tool input blanked 1 day after settling; row deleted 30 days after, unless an open item, active dag or live agent refers to it', approvalSweep),
  decision: sweep('orphaned (its approval was deleted) and 30+ days old', (ctx, now, limit) =>
    deleteBatch(ctx, 'decision', 'created_at < ? AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.decision_id = decision.id)', limit, now - SETTLED_RETENTION_MS)),
  dag: sweep('done/failed/cancelled 30+ days ago; tasks, gates and dispatches cascade', (ctx, now, limit) =>
    deleteBatch(ctx, 'dag', "status != 'active' AND updated_at < ?", limit, now - SETTLED_RETENTION_MS)),
  dag_task: { kind: 'cascade', parent: 'dag', rule: 'ON DELETE CASCADE from dag' },
  dag_gate: { kind: 'cascade', parent: 'dag', rule: 'ON DELETE CASCADE from dag' },
  dag_dispatch: { kind: 'cascade', parent: 'dag_task', rule: 'ON DELETE CASCADE from dag_task' },
  central_event: sweep('replay events 30+ days old whose turn is settled (no conversation is archived; turns end)', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_event', `created_at < ? AND (turn_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM central_turn t WHERE t.id = central_event.turn_id AND t.status NOT IN (${TERMINAL_TURNS})))`, limit, now - SETTLED_RETENTION_MS)),
  agent_mail: sweep('expired (24 h TTL set at send)', (ctx, now, limit) => deleteBatch(ctx, 'agent_mail', 'expires_at <= ?', limit, now)),
  cost_usage: sweep('responses 400+ days old (caps only read today and the current dag)', (ctx, now, limit) =>
    deleteBatch(ctx, 'cost_usage', 'ts < ?', limit, now - USAGE_RETENTION_MS)),
  cost_run: sweep('ended 400+ days ago and not a run of a still-active dag (dag caps sum all time)', (ctx, now, limit) =>
    deleteBatch(ctx, 'cost_run', `ended_at IS NOT NULL AND ended_at < ?
      AND NOT (kind = 'dag' AND EXISTS (SELECT 1 FROM dag WHERE dag.id = cost_run.ref AND dag.status = 'active'))`, limit, now - USAGE_RETENTION_MS)),
  central_budget: sweep('day rows 400+ days old (the guard reads today only)', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_budget', 'day < ?', limit, new Date(now - USAGE_RETENTION_MS).toISOString().slice(0, 10))),

  event_chain_base: exempt('single row (id = 1): the pruned chain origin'),
  usage: exempt('ledger budgets sum all usage of a project (checkBudget); pruning would reset spend. Deleted with its project'),
  run: exempt('parent of usage (same reason); deleted with its project'),
  project: exempt('user-created; removed by deleteProject / workspace delete'),
  agent: exempt(PROJECT_SCOPED), task: exempt(PROJECT_SCOPED), plan: exempt(PROJECT_SCOPED),
  plan_item: exempt('replaced wholesale per plan (orchestrator/plan.ts); deleted with its plan'),
  budget: exempt(PROJECT_SCOPED), prefix: exempt(PROJECT_SCOPED),
  memory: exempt('user-curated knowledge; removed by the memory forget/tombstone flow'),
  memory_embedding: exempt('one row per memory; follows memory'),
  memory_event: exempt('memory audit trail; follows memory'),
  memory_tombstone: exempt('must persist so forgotten facts are never re-learned'),
  memory_incognito: exempt('user privacy switches, one row per scope'),
  memory_fts: exempt(FTS_SHADOW), memory_fts_config: exempt(FTS_SHADOW), memory_fts_data: exempt(FTS_SHADOW),
  memory_fts_docsize: exempt(FTS_SHADOW), memory_fts_idx: exempt(FTS_SHADOW),
  memory_fts_tri: exempt(FTS_SHADOW), memory_fts_tri_config: exempt(FTS_SHADOW), memory_fts_tri_data: exempt(FTS_SHADOW),
  memory_fts_tri_docsize: exempt(FTS_SHADOW), memory_fts_tri_idx: exempt(FTS_SHADOW),
  request_ack: exempt('bounded by its own module (durableAck.ts: TTL + ACK_LIMIT on every write)'),
  tool_cache: exempt('bounded by its own module (toolCache.ts TOOL_CACHE_MAX)'),
  embed_cache: exempt('bounded by its own module (embedCache.ts EMBED_CACHE_MAX)'),
  routine_run: exempt('bounded by its own module (routineStore.ts keeps 200 runs per routine)'),
  routine: exempt('user configuration'),
  policy_grant: exempt('user configuration (standing grants)'), policy_principal: exempt('user configuration'),
  policy_tier_min: exempt('user configuration'), policy_token: exempt('credentials, revoked explicitly'),
  central_control: exempt('configuration, one row per key'), cost_cap: exempt('user configuration'),
  channel_store: exempt('single document row (channels config + bounded reply queue)'),
  central_conversation: exempt('one row per scope (UNIQUE), the chat itself'),
  central_message: exempt('user-visible chat history, kept like a transcript'),
  central_turn: exempt('one row per chat turn, read with its messages'),
  central_checkpoint: exempt('conversation context state, replaced per conversation'),
  central_agents: exempt('live agents and their resume approvals; small, ended rows are history'),
  central_breaker: exempt('one row per breaker key'),
  central_skill: exempt('skill registry, one row per skill version'),
  bakeoff: exempt('human-started runs that own worktree cleanup state'),
  bakeoff_candidate: exempt('children of bakeoff'),
  eval_case: exempt('curated eval dataset'),
  sqlite_sequence: exempt('SQLite internal (AUTOINCREMENT counters)'),
}
