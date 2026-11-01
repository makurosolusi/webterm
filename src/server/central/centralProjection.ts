// Read-only portfolio projection: a fixed set of GROUP BY aggregate statements over the
// ledger. No per-project loop, no writes. Kept apart from central.ts so mutations stay
// small and this read model can be reviewed on its own.
import type { Database } from 'bun:sqlite'
import { allRows, getRow } from '../ledger/ledgerCore'
import {
  type BudgetSummary,
  type PlanSummary,
  type PortfolioEntry,
  type PortfolioOptions,
  type PortfolioPage,
  type TaskBrief,
  type TaskCounts,
  type UsageSummary,
  clampPortfolioLimit,
  clampPortfolioOffset,
  emptyTaskCounts,
  validateProjectId,
} from './centralModel'

const ZERO_USAGE: UsageSummary = {
  costMicros: 0,
  inputTokens: 0,
  outputTokens: 0,
  unpricedRecords: 0,
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

function num(value: unknown): number {
  return Number(value ?? 0)
}

interface ProjectRow {
  id: string
  name: string
  status: string
  priority: number
  updated_at: number
}

/** Plan status/version plus item counts, one row per project with a plan. */
function planSummaries(db: Database, ids: string[]): Map<string, PlanSummary> {
  const rows = allRows(
    db,
    `SELECT pl.project_id AS project_id, pl.id AS id, pl.status AS status, pl.version AS version,
       COUNT(pi.id) AS total,
       COALESCE(SUM(CASE WHEN pi.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN pi.status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned,
       COALESCE(SUM(CASE WHEN pi.status = 'running' THEN 1 ELSE 0 END), 0) AS running,
       COALESCE(SUM(CASE WHEN pi.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
       COALESCE(SUM(CASE WHEN pi.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN pi.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
     FROM plan pl LEFT JOIN plan_item pi ON pi.plan_id = pl.id
     WHERE pl.project_id IN (${placeholders(ids.length)})
     GROUP BY pl.id`,
    ...ids
  )
  const out = new Map<string, PlanSummary>()
  for (const r of rows) {
    out.set(String(r['project_id']), {
      id: String(r['id']),
      status: String(r['status']),
      version: num(r['version']),
      items: {
        total: num(r['total']),
        pending: num(r['pending']),
        assigned: num(r['assigned']),
        running: num(r['running']),
        done: num(r['done']),
        failed: num(r['failed']),
        cancelled: num(r['cancelled']),
      },
    })
  }
  return out
}

function taskCounts(db: Database, ids: string[]): Map<string, TaskCounts> {
  const rows = allRows(
    db,
    `SELECT project_id, status, COUNT(*) AS count
     FROM task WHERE project_id IN (${placeholders(ids.length)})
     GROUP BY project_id, status`,
    ...ids
  )
  const out = new Map<string, TaskCounts>()
  for (const r of rows) {
    const projectId = String(r['project_id'])
    const counts = out.get(projectId) ?? emptyTaskCounts()
    const status = String(r['status']) as keyof TaskCounts
    if (status in counts) counts[status] = num(r['count'])
    out.set(projectId, counts)
  }
  return out
}

/** Pending, non-expired approvals per project (expired rows are not actionable). */
function pendingApprovals(db: Database, ids: string[], now: number): Map<string, number> {
  const rows = allRows(
    db,
    `SELECT project_id, COUNT(*) AS count FROM approval
     WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
       AND project_id IN (${placeholders(ids.length)})
     GROUP BY project_id`,
    now,
    ...ids
  )
  const out = new Map<string, number>()
  for (const r of rows) out.set(String(r['project_id']), num(r['count']))
  return out
}

/** Newest verified and newest failed task per project: one windowed statement. */
function latestTasks(
  db: Database,
  ids: string[]
): Map<string, { verified: TaskBrief | null; failed: TaskBrief | null }> {
  const rows = allRows(
    db,
    `SELECT project_id, status, id, updated_at FROM (
       SELECT project_id, status, id, updated_at,
         ROW_NUMBER() OVER (
           PARTITION BY project_id, status ORDER BY updated_at DESC, id ASC
         ) AS rn
       FROM task
       WHERE status IN ('verified', 'failed') AND project_id IN (${placeholders(ids.length)})
     ) WHERE rn = 1`,
    ...ids
  )
  const out = new Map<string, { verified: TaskBrief | null; failed: TaskBrief | null }>()
  for (const r of rows) {
    const projectId = String(r['project_id'])
    const entry = out.get(projectId) ?? { verified: null, failed: null }
    const brief: TaskBrief = { id: String(r['id']), updatedAt: num(r['updated_at']) }
    if (r['status'] === 'verified') entry.verified = brief
    else entry.failed = brief
    out.set(projectId, entry)
  }
  return out
}

function budgets(db: Database, ids: string[]): Map<string, BudgetSummary> {
  const rows = allRows(
    db,
    `SELECT project_id, SUM(limit_micros) AS limit_micros, SUM(spent_micros) AS spent_micros,
       MAX(hard_cap) AS hard_cap
     FROM budget WHERE project_id IN (${placeholders(ids.length)})
     GROUP BY project_id`,
    ...ids
  )
  const out = new Map<string, BudgetSummary>()
  for (const r of rows) {
    out.set(String(r['project_id']), {
      limitMicros: num(r['limit_micros']),
      spentMicros: num(r['spent_micros']),
      hardCap: num(r['hard_cap']) === 1,
    })
  }
  return out
}

/** Usage aggregated per project; priced cost stays separate from unpriced rows. */
function usage(db: Database, ids: string[]): Map<string, UsageSummary> {
  const rows = allRows(
    db,
    `SELECT r.project_id AS project_id,
       COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
       COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
       COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
       COALESCE(SUM(CASE WHEN u.id IS NOT NULL AND u.price_known = 0 THEN 1 ELSE 0 END), 0) AS unpriced
     FROM run r LEFT JOIN usage u ON u.run_id = r.id
     WHERE r.project_id IN (${placeholders(ids.length)})
     GROUP BY r.project_id`,
    ...ids
  )
  const out = new Map<string, UsageSummary>()
  for (const r of rows) {
    out.set(String(r['project_id']), {
      costMicros: num(r['cost_micros']),
      inputTokens: num(r['input_tokens']),
      outputTokens: num(r['output_tokens']),
      unpricedRecords: num(r['unpriced']),
    })
  }
  return out
}

/**
 * Cross-project portfolio projection. Reads only. A supplied `projectId` scopes the
 * page to one project; otherwise every project is included in priority order.
 */
export function portfolio(db: Database, opts: PortfolioOptions = {}): PortfolioPage {
  const limit = clampPortfolioLimit(opts.limit)
  const offset = clampPortfolioOffset(opts.offset)
  const projectId = opts.projectId === undefined ? undefined : validateProjectId(opts.projectId)
  const where = projectId === undefined ? '' : 'WHERE id = ?'
  const filter = projectId === undefined ? [] : [projectId]
  const totalRow = getRow(db, `SELECT COUNT(*) AS count FROM project ${where}`, ...filter)
  const rows = allRows(
    db,
    `SELECT id, name, status, priority, updated_at FROM project ${where}
     ORDER BY priority DESC, created_at ASC, id ASC LIMIT ? OFFSET ?`,
    ...filter,
    limit,
    offset
  ) as unknown as ProjectRow[]
  if (rows.length === 0) {
    return { items: [], total: num(totalRow?.['count']), limit, offset }
  }
  const ids = rows.map((r) => String(r.id))
  const now = Date.now()
  const plans = planSummaries(db, ids)
  const counts = taskCounts(db, ids)
  const approvals = pendingApprovals(db, ids, now)
  const latest = latestTasks(db, ids)
  const budgetByProject = budgets(db, ids)
  const usageByProject = usage(db, ids)

  const items: PortfolioEntry[] = rows.map((r) => {
    const id = String(r.id)
    const tasks = counts.get(id) ?? emptyTaskCounts()
    return {
      id,
      name: String(r.name),
      status: String(r.status),
      priority: num(r.priority),
      updatedAt: num(r.updated_at),
      plan: plans.get(id) ?? null,
      tasks,
      taskTotal: Object.values(tasks).reduce((sum, n) => sum + n, 0),
      pendingApprovals: approvals.get(id) ?? 0,
      latest: latest.get(id) ?? { verified: null, failed: null },
      budget: budgetByProject.get(id) ?? null,
      usage: usageByProject.get(id) ?? ZERO_USAGE,
    }
  })
  return { items, total: num(totalRow?.['count']), limit, offset }
}

export function projectPortfolio(db: Database, projectId: string): PortfolioEntry | null {
  return portfolio(db, { projectId, limit: 1, offset: 0 }).items[0] ?? null
}
