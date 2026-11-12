// The ledger retention registry (data-209-10, agent-211-C4): every ledger table maps to exactly one
// policy — a batched sweep, a cascade from a swept parent, or an exemption with its reason. The
// policy test (ledgerRetention.policy.bun.test.ts) fails when a table in the live schema has none.
//
// Every sweep deletes at most `limit` rows per call (`rowid IN (SELECT ... LIMIT ?)`), only rows in
// a settled end state past their age, and never a row something open still points at.
import { TURN_STATUSES, isActiveTurnStatus } from '../central/conversationModel'
import { execWrite, type LedgerContext } from './ledgerCore'
import { sweepMessages, sweepTurns } from './ledgerRetentionChat'
import { pruneAuditEvents, pruneEventChain } from './ledgerRetentionEvent'
import { sweepRejectedSkills } from './ledgerRetentionSkill'

const DAY_MS = 24 * 60 * 60 * 1000
/** Settled work rows (outbox, inbox, approvals, dags, chat replay events) are kept this long. */
export const SETTLED_RETENTION_MS = 30 * DAY_MS
/** Spend history is kept a little over a year, so a year-on-year view still has data. */
export const USAGE_RETENTION_MS = 400 * DAY_MS
/**
 * Ledger `usage` / `run` (per-project spend behind the project cost totals) follow the same 400 days as
 * cost_usage. Readers: sumUsage/brief use a `since` window; checkBudget's all-time sum has no caller
 * outside tests; the project cost total becomes "last 400 days".
 */
export const LEDGER_USAGE_RETENTION_MS = USAGE_RETENTION_MS
export const LEDGER_RUN_RETENTION_MS = USAGE_RETENTION_MS
/** A forgotten memory keeps its audit trail (who forgot it, when) this long; the scrubbed row and tombstone stay. */
export const FORGOTTEN_MEMORY_EVENT_RETENTION_MS = 90 * DAY_MS
/** A settled approval keeps its tool input (≤ 32 KB) this long for the history view, then it is blanked. */
export const APPROVAL_INPUT_GRACE_MS = DAY_MS

export type Sweep = (ctx: LedgerContext, now: number, limit: number) => number

export type RetentionEntry =
  | { kind: 'sweep'; rule: string; sweep: Sweep }
  | { kind: 'cascade'; parent: string; rule: string }
  | { kind: 'exempt'; reason: string }

const SETTLED_WORK = `'done', 'cancelled', 'failed'`
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

/** Run order matters: approvals before decisions (orphans), dags before their cost runs, usage before runs. */
export const RETENTION: Record<string, RetentionEntry> = {
  event: sweep('chained rows past 30 days or 200k rows (prefix only, chain stays verifiable); audit rows past 90 days or 200k rows; '
    + 'the newest row of each setting kind and the timeline of an existing work task stay', (ctx, now, limit) => pruneEventChain(ctx, now, limit) + pruneAuditEvents(ctx, now, limit)),
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
  central_task: sweep('done/cancelled/failed 30+ days ago, no open assignment and no unsettled dependent; deps and assignments cascade', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_task', `status IN (${SETTLED_WORK}) AND updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM central_assignment a WHERE a.task_id = central_task.id AND a.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM central_task_dep d JOIN central_task t ON t.id = d.task_id WHERE d.blocked_by_id = central_task.id AND t.status NOT IN (${SETTLED_WORK}))`, limit, now - SETTLED_RETENTION_MS)),
  central_task_dep: { kind: 'cascade', parent: 'central_task', rule: 'ON DELETE CASCADE from central_task' },
  central_assignment: { kind: 'cascade', parent: 'central_task', rule: 'ON DELETE CASCADE from central_task' },
  central_reminder: sweep('fired or cancelled, created 30+ days ago', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_reminder', "status != 'pending' AND created_at < ?", limit, now - SETTLED_RETENTION_MS)),
  central_checkin_reason: sweep('delivered 30+ days ago; an overdue row stays with its task so the task never fires twice', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_checkin_reason', "sent_at IS NOT NULL AND sent_at < ? AND kind != 'task_overdue'", limit, now - SETTLED_RETENTION_MS)),
  central_finding: sweep('fixed 30+ days ago; open findings and dismissed ones (the human reason stops repeats) stay', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_finding', "status = 'fixed' AND fixed_at < ?", limit, now - SETTLED_RETENTION_MS)),
  central_health_scan: sweep('started 30+ days ago and not the latest run of its project and origin (lastScanAt reads it)', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_health_scan', `started_at < ? AND EXISTS (SELECT 1 FROM central_health_scan n
      WHERE n.project_id = central_health_scan.project_id AND n.origin = central_health_scan.origin AND n.started_at > central_health_scan.started_at)`, limit, now - SETTLED_RETENTION_MS)),
  central_message: sweep('system notices 30+ days old, then all but the newest 5000 per conversation; never a running turn, '
    + 'the current /model choice, or a notice whose inbox item or work task is still open', sweepMessages),
  central_turn: sweep('context trace blanked 30 days after a settled turn started; settled turns past the newest 2500 per conversation deleted', sweepTurns),
  memory_event: sweep('events of a forgotten memory (scrubbed row) 90+ days old; rows of a deleted memory cascade', (ctx, now, limit) =>
    deleteBatch(ctx, 'memory_event', "ts < ? AND memory_id IN (SELECT id FROM memory WHERE substr(key, 1, 10) = 'forgotten:')", limit, now - FORGOTTEN_MEMORY_EVENT_RETENTION_MS)),
  central_skill: sweep('rejected proposals 30+ days old, with their proposed/ folder (only inside the skills root)', (ctx, now, limit) => sweepRejectedSkills(ctx, now, limit)),
  central_agents: sweep('ended 30+ days ago (live agents and their resume approvals stay)', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_agents', 'ended_at IS NOT NULL AND ended_at < ?', limit, now - SETTLED_RETENTION_MS)),
  central_playbook_run: sweep('last moved 30+ days ago and not waiting on a pending approval card', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_playbook_run', `updated_at < ? AND NOT (status = 'waiting'
      AND EXISTS (SELECT 1 FROM approval a WHERE a.id = central_playbook_run.approval_id AND a.status = 'pending'))`, limit, now - SETTLED_RETENTION_MS)),
  usage: sweep('responses 400+ days old (spend reads use a since window)', (ctx, now, limit) =>
    deleteBatch(ctx, 'usage', 'ts < ?', limit, now - LEDGER_USAGE_RETENTION_MS)),
  run: sweep('started 400+ days ago, once all its usage rows have aged out', (ctx, now, limit) =>
    deleteBatch(ctx, 'run', 'started_at < ? AND NOT EXISTS (SELECT 1 FROM usage u WHERE u.run_id = run.id)', limit, now - LEDGER_RUN_RETENTION_MS)),
  agent_mail: sweep('expired (24 h TTL set at send)', (ctx, now, limit) => deleteBatch(ctx, 'agent_mail', 'expires_at <= ?', limit, now)),
  cost_usage: sweep('responses 400+ days old (caps only read today and the current dag)', (ctx, now, limit) =>
    deleteBatch(ctx, 'cost_usage', 'ts < ?', limit, now - USAGE_RETENTION_MS)),
  cost_run: sweep('ended 400+ days ago and not a run of a still-active dag (dag caps sum all time)', (ctx, now, limit) =>
    deleteBatch(ctx, 'cost_run', `ended_at IS NOT NULL AND ended_at < ?
      AND NOT (kind = 'dag' AND EXISTS (SELECT 1 FROM dag WHERE dag.id = cost_run.ref AND dag.status = 'active'))`, limit, now - USAGE_RETENTION_MS)),
  central_budget: sweep('day rows 400+ days old (the guard reads today only)', (ctx, now, limit) =>
    deleteBatch(ctx, 'central_budget', 'day < ?', limit, new Date(now - USAGE_RETENTION_MS).toISOString().slice(0, 10))),

  event_chain_base: exempt('single row (id = 1): the pruned chain origin'),
  project: exempt('user-created; removed by deleteProject / workspace delete'),
  agent: exempt(PROJECT_SCOPED), task: exempt(PROJECT_SCOPED), plan: exempt(PROJECT_SCOPED),
  plan_item: exempt('replaced wholesale per plan (orchestrator/plan.ts); deleted with its plan'),
  budget: exempt(PROJECT_SCOPED), prefix: exempt(PROJECT_SCOPED),
  memory: exempt('user-curated knowledge; removed by the memory forget/tombstone flow'),
  memory_embedding: exempt('one row per memory; follows memory'),
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
  central_checkpoint: exempt('conversation context state, replaced per conversation'),
  central_state: exempt('one capped document per scope, overwritten in place; project rows cascade with their project'),
  central_breaker: exempt('one row per breaker key'),
  bakeoff: exempt('human-started runs that own worktree cleanup state'),
  bakeoff_candidate: exempt('children of bakeoff'),
  eval_case: exempt('curated eval dataset'),
  sqlite_sequence: exempt('SQLite internal (AUTOINCREMENT counters)'),
}
