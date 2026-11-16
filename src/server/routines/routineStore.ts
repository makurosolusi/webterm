// Persistence of routines and their run history over the ledger (schema v15; `estimate_usd` v17).
import { allRows, execWrite, getRow, newId, type LedgerContext, type Row } from '../ledger/ledgerCore'
import { nextCronAfter } from './routineCron'
import { RETRIED_PREFIX, RETRYABLE_PREFIX, type Routine, type RoutineInput, type RoutineRun, type RunStatus, type RunTrigger } from './routineModel'

/** Runs kept per routine; older rows are pruned on insert (Orca run retention). */
export const RUN_HISTORY_MAX = 200
export const RUN_LIST_MAX = 100
const DAY_MS = 86_400_000

const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : null)
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function toRoutine(r: Row): Routine {
  return {
    id: String(r['id']), name: String(r['name']), enabled: Number(r['enabled']) === 1,
    workspaceId: (r['workspace_id'] as string | null) ?? null,
    trigger: parse(r['trigger_json']) as Routine['trigger'],
    precheck: parse(r['precheck_json']) as Routine['precheck'],
    action: parse(r['action_json']) as Routine['action'],
    budget: parse(r['budget_json']) as Routine['budget'],
    nextRunAt: num(r['next_run_at']), createdAt: Number(r['created_at']), updatedAt: Number(r['updated_at']),
  }
}

function toRun(r: Row): RoutineRun {
  return {
    id: String(r['id']), routineId: String(r['routine_id']), trigger: r['trigger'] as RunTrigger,
    status: r['status'] as RunStatus, reason: (r['reason'] as string | null) ?? null,
    scheduledFor: num(r['scheduled_for']), startedAt: Number(r['started_at']), finishedAt: num(r['finished_at']),
    costUsd: num(r['cost_usd']), estimateUsd: num(r['estimate_usd']), inboxItemId: (r['inbox_item_id'] as string | null) ?? null, childId: (r['child_id'] as string | null) ?? null,
  }
}

const nextSlot = (input: RoutineInput, now: number): number | null =>
  input.trigger.type === 'schedule' ? nextCronAfter(input.trigger.cron, now) : null

export function createRoutineStore(ctx: LedgerContext) {
  const { db } = ctx
  const get = (id: string): Routine | null => {
    const r = getRow(db, 'SELECT * FROM routine WHERE id = ?', id)
    return r ? toRoutine(r) : null
  }
  return {
    get,
    list: (): Routine[] => allRows(db, 'SELECT * FROM routine ORDER BY created_at').map(toRoutine),

    create(input: RoutineInput): Routine {
      const id = newId()
      const now = ctx.now()
      execWrite(db, `INSERT INTO routine (id, name, enabled, workspace_id, trigger_json, precheck_json, action_json, budget_json, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.name, input.enabled ? 1 : 0, input.workspaceId, JSON.stringify(input.trigger),
      input.precheck ? JSON.stringify(input.precheck) : null, JSON.stringify(input.action), JSON.stringify(input.budget), nextSlot(input, now), now, now)
      return get(id)!
    },

    /** Replaces the definition; the next slot is recomputed from now (an edit never back-fires). */
    update(id: string, input: RoutineInput): Routine | null {
      const now = ctx.now()
      const n = execWrite(db, `UPDATE routine SET name = ?, enabled = ?, workspace_id = ?, trigger_json = ?, precheck_json = ?, action_json = ?,
        budget_json = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, input.name, input.enabled ? 1 : 0, input.workspaceId,
      JSON.stringify(input.trigger), input.precheck ? JSON.stringify(input.precheck) : null, JSON.stringify(input.action),
      JSON.stringify(input.budget), nextSlot(input, now), now, id)
      return n > 0 ? get(id) : null
    },

    remove: (id: string): boolean => execWrite(db, 'DELETE FROM routine WHERE id = ?', id) > 0,

    setNextRun: (id: string, at: number | null): void => { execWrite(db, 'UPDATE routine SET next_run_at = ? WHERE id = ?', at, id) },

    /** Enabled schedule routines whose slot has come. */
    due: (now: number): Routine[] =>
      allRows(db, 'SELECT * FROM routine WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', now).map(toRoutine),

    addRun(input: { routineId: string; trigger: RunTrigger; status: RunStatus; reason?: string | null; scheduledFor?: number | null }): RoutineRun {
      const id = newId()
      const now = ctx.now()
      const final = input.status !== 'running'
      execWrite(db, `INSERT INTO routine_run (id, routine_id, trigger, status, reason, scheduled_for, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, input.routineId, input.trigger, input.status, input.reason ?? null, input.scheduledFor ?? null, now, final ? now : null)
      execWrite(db, `DELETE FROM routine_run WHERE routine_id = ? AND id NOT IN
        (SELECT id FROM routine_run WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`, input.routineId, input.routineId, RUN_HISTORY_MAX)
      return toRun(getRow(db, 'SELECT * FROM routine_run WHERE id = ?', id)!)
    },

    finishRun(id: string, change: { status: RunStatus; reason?: string | null; costUsd?: number | null; estimateUsd?: number | null; inboxItemId?: string | null; childId?: string | null }): void {
      execWrite(db, `UPDATE routine_run SET status = ?, reason = COALESCE(?, reason), finished_at = ?, cost_usd = COALESCE(?, cost_usd),
        estimate_usd = COALESCE(?, estimate_usd), inbox_item_id = COALESCE(?, inbox_item_id), child_id = COALESCE(?, child_id) WHERE id = ?`,
      change.status, change.reason ?? null, change.status === 'running' ? null : ctx.now(), change.costUsd ?? null, change.estimateUsd ?? null,
      change.inboxItemId ?? null, change.childId ?? null, id)
    },

    runs(routineId: string, limit = 50, offset = 0): RoutineRun[] {
      const l = Math.min(Math.max(1, Math.floor(limit)), RUN_LIST_MAX)
      return allRows(db, 'SELECT * FROM routine_run WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?', routineId, l, Math.max(0, Math.floor(offset))).map(toRun)
    },

    lastRun: (routineId: string): RoutineRun | null => {
      const r = getRow(db, 'SELECT * FROM routine_run WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', routineId)
      return r ? toRun(r) : null
    },

    isRunning: (routineId: string): boolean => !!getRow(db, "SELECT 1 FROM routine_run WHERE routine_id = ? AND status = 'running' LIMIT 1", routineId),

    /** Runs that spent budget (ran, failed, still running) and their cost over the last 24 h. */
    spentToday(routineId: string): { runs: number; costUsd: number } {
      const r = getRow(db, `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS c FROM routine_run
        WHERE routine_id = ? AND status IN ('running', 'ran', 'failed') AND started_at > ?`, routineId, ctx.now() - DAY_MS)
      return { runs: Number(r?.['n'] ?? 0), costUsd: Number(r?.['c'] ?? 0) }
    },

    /**
     * A run left `running` by a crashed process can never finish; close it at boot. A run that overlaps a connectivity
     * episode (open, or ended after the run began) died of the outage, not of a fault: it becomes a retry candidate
     * (`interrupted_network`) instead of a permanent failure. Without episodes this is the old behaviour exactly.
     */
    failOrphans(episodes: readonly { startedAt: number; endedAt: number | null }[] = []): number {
      const now = ctx.now()
      let n = 0
      for (const r of allRows(db, "SELECT id, started_at FROM routine_run WHERE status = 'running'")) {
        const started = Number(r['started_at'])
        const outage = episodes.some((e) => e.startedAt <= now && (e.endedAt === null || e.endedAt >= started))
        const reason = outage ? `${RETRYABLE_PREFIX}[network]: interrupted_network` : 'interrupted'
        n += execWrite(db, "UPDATE routine_run SET status = 'failed', reason = ?, finished_at = ? WHERE id = ?", reason, now, String(r['id']))
      }
      return n
    },

    /** Failed runs waiting for their one retry, at least `delayMs` after they ended (the detector needs time to call an outage). */
    retryCandidates: (delayMs: number): RoutineRun[] =>
      allRows(db, "SELECT * FROM routine_run WHERE status = 'failed' AND reason LIKE ? AND finished_at <= ? ORDER BY finished_at LIMIT ?", `${RETRYABLE_PREFIX}[%`, ctx.now() - delayMs, RUN_LIST_MAX).map(toRun),

    /** Spends a run's one retry (the prefix swap keeps the original reason readable). */
    markRetried: (runId: string): void => { execWrite(db, 'UPDATE routine_run SET reason = ? || substr(reason, ?) WHERE id = ? AND reason LIKE ?', RETRIED_PREFIX, RETRYABLE_PREFIX.length + 1, runId, `${RETRYABLE_PREFIX}[%`) },
  }
}

export type RoutineStore = ReturnType<typeof createRoutineStore>
