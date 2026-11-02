// Run, token usage, and budget repositories. Usage buckets are nullable on purpose:
// `unknown != 0`, so a provider that omits cache numbers must not be recorded as free.
import {
  LedgerError,
  LedgerNotFoundError,
} from './ledgerModel'
import {
  type LedgerContext,
  allRows,
  execInsert,
  execWrite,
  getRow,
  jsonOf,
  newId,
  requireText,
} from './ledgerCore'
import { clampPageLimit, clampPageOffset } from './ledgerTaskShared'
import {
  type Budget,
  type BudgetCheck,
  type FinishRunInput,
  type RecordUsageInput,
  type Run,
  type StartRunInput,
  type UsageRecord,
  optionalCount,
  toBudget,
  toRun,
  toUsage,
} from './ledgerUsageModel'

export * from './ledgerUsageModel'

export function startRun(ctx: LedgerContext, input: StartRunInput): Run {
  const at = input.startedAt ?? ctx.now()
  if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 2) {
    throw new LedgerError(`run.depth must be 0..2, got ${input.depth}`)
  }
  const id = input.id ?? newId()
  execInsert(
    ctx.db,
    `INSERT INTO run (id, project_id, task_id, agent_id, depth, provider, model, route,
       prefix_hash, tools_hash, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    requireText(input.projectId, 'run.projectId'),
    input.taskId ?? null,
    input.agentId ?? null,
    input.depth,
    input.provider ?? null,
    input.model ?? null,
    input.route ?? null,
    input.prefixHash ?? null,
    input.toolsHash ?? null,
    at
  )
  return runById(ctx, id)
}

function runById(ctx: LedgerContext, id: string): Run {
  const row = getRow(ctx.db, 'SELECT * FROM run WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('run', id)
  return toRun(row)
}

/** Idempotent: finishing an already-finished run returns the stored row unchanged. */
export function finishRun(ctx: LedgerContext, id: string, input: FinishRunInput): Run {
  const at = input.endedAt ?? ctx.now()
  execWrite(
    ctx.db,
    `UPDATE run SET outcome = ?, failure_label = ?, evidence_json = ?, versions_json = ?,
       ended_at = ? WHERE id = ? AND ended_at IS NULL`,
    requireText(input.outcome, 'run.outcome'),
    input.failureLabel ?? null,
    jsonOf(input.evidence, 'run.evidence'),
    jsonOf(input.versions, 'run.versions'),
    at,
    id
  )
  return runById(ctx, id)
}

export function getRun(ctx: LedgerContext, id: string): Run | null {
  const row = getRow(ctx.db, 'SELECT * FROM run WHERE id = ?', id)
  return row ? toRun(row) : null
}

export function listRuns(
  ctx: LedgerContext,
  projectId: string,
  opts: { limit?: number; offset?: number } = {}
): Run[] {
  const limit = clampPageLimit(opts.limit, 'listRuns')
  const offset = clampPageOffset(opts.offset, 'listRuns')
  return allRows(
    ctx.db,
    'SELECT * FROM run WHERE project_id = ? ORDER BY started_at ASC, id ASC LIMIT ? OFFSET ?',
    projectId,
    limit,
    offset
  ).map(toRun)
}

/** Returns the existing row when `provider_response_id` was already recorded. */
export function recordUsage(ctx: LedgerContext, input: RecordUsageInput): UsageRecord {
  const providerId = input.providerResponseId ?? null
  if (providerId !== null) {
    const existing = getRow(
      ctx.db,
      'SELECT * FROM usage WHERE provider_response_id = ?',
      providerId
    )
    if (existing) return toUsage(existing)
  }
  const id = input.id ?? newId()
  execInsert(
    ctx.db,
    `INSERT INTO usage (id, run_id, provider_response_id, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_micros, price_known, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    requireText(input.runId, 'usage.runId'),
    providerId,
    optionalCount(input.inputTokens, 'usage.inputTokens'),
    optionalCount(input.outputTokens, 'usage.outputTokens'),
    optionalCount(input.cacheReadTokens, 'usage.cacheReadTokens'),
    optionalCount(input.cacheWriteTokens, 'usage.cacheWriteTokens'),
    optionalCount(input.costMicros, 'usage.costMicros'),
    input.priceKnown === true ? 1 : 0,
    input.ts ?? ctx.now()
  )
  const row = getRow(ctx.db, 'SELECT * FROM usage WHERE id = ?', id)
  if (!row) throw new LedgerError(`usage ${id} disappeared after insert`)
  return toUsage(row)
}

export function getUsage(ctx: LedgerContext, runId: string): UsageRecord[] {
  return allRows(
    ctx.db,
    'SELECT * FROM usage WHERE run_id = ? ORDER BY ts ASC, id ASC',
    runId
  ).map(toUsage)
}

/** Cost/token totals. Unknown prices stay out of `costMicros` instead of counting as zero. */
export function sumUsage(
  ctx: LedgerContext,
  projectId: string,
  opts: { since?: number } = {}
): { costMicros: number; inputTokens: number; outputTokens: number; unpricedRecords: number } {
  const row = getRow(
    ctx.db,
    `SELECT
       COALESCE(SUM(u.cost_micros), 0) AS cost,
       COALESCE(SUM(u.input_tokens), 0) AS input,
       COALESCE(SUM(u.output_tokens), 0) AS output,
       COALESCE(SUM(CASE WHEN u.price_known = 0 THEN 1 ELSE 0 END), 0) AS unpriced
     FROM usage u JOIN run r ON r.id = u.run_id
     WHERE r.project_id = ? AND u.ts >= ?`,
    projectId,
    opts.since ?? 0
  )
  return {
    costMicros: Number(row?.['cost'] ?? 0),
    inputTokens: Number(row?.['input'] ?? 0),
    outputTokens: Number(row?.['output'] ?? 0),
    unpricedRecords: Number(row?.['unpriced'] ?? 0),
  }
}

export function setBudget(
  ctx: LedgerContext,
  input: {
    projectId: string
    limitMicros: number
    scope?: string
    period?: string
    hardCap?: boolean
    spentMicros?: number
  }
): Budget {
  const projectId = requireText(input.projectId, 'budget.projectId')
  if (!Number.isInteger(input.limitMicros) || input.limitMicros < 0) {
    throw new LedgerError(`budget.limitMicros must be a non-negative integer, got ${input.limitMicros}`)
  }
  const scope = input.scope ?? 'project'
  const period = input.period ?? 'total'
  const at = ctx.now()
  const existing = getRow(
    ctx.db,
    'SELECT id FROM budget WHERE project_id = ? AND scope = ? AND period = ?',
    projectId,
    scope,
    period
  )
  if (existing) {
    execWrite(
      ctx.db,
      `UPDATE budget SET limit_micros = ?, spent_micros = ?, hard_cap = ?, updated_at = ?
       WHERE id = ?`,
      input.limitMicros,
      optionalCount(input.spentMicros, 'budget.spentMicros') ?? 0,
      input.hardCap === false ? 0 : 1,
      at,
      String(existing['id'])
    )
    return budgetById(ctx, String(existing['id']))
  }
  const id = newId()
  execInsert(
    ctx.db,
    `INSERT INTO budget (id, project_id, scope, period, limit_micros, spent_micros, hard_cap, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    projectId,
    scope,
    period,
    input.limitMicros,
    optionalCount(input.spentMicros, 'budget.spentMicros') ?? 0,
    input.hardCap === false ? 0 : 1,
    at
  )
  return budgetById(ctx, id)
}

function budgetById(ctx: LedgerContext, id: string): Budget {
  const row = getRow(ctx.db, 'SELECT * FROM budget WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('budget', id)
  return toBudget(row)
}

export function getBudget(
  ctx: LedgerContext,
  projectId: string,
  scope = 'project',
  period = 'total'
): Budget | null {
  const row = getRow(
    ctx.db,
    'SELECT * FROM budget WHERE project_id = ? AND scope = ? AND period = ?',
    projectId,
    scope,
    period
  )
  return row ? toBudget(row) : null
}

/** Hard cap check: no budget row means unlimited. */
export function checkBudget(
  ctx: LedgerContext,
  input: { projectId: string; estimateMicros?: number; scope?: string; period?: string }
): BudgetCheck {
  const budget = getBudget(ctx, input.projectId, input.scope, input.period)
  const spentMicros = sumUsage(ctx, input.projectId).costMicros
  if (!budget) {
    return { allowed: true, spentMicros, limitMicros: 0, remainingMicros: 0, hardCap: false }
  }
  const estimate = input.estimateMicros ?? 0
  if (!Number.isInteger(estimate) || estimate < 0) {
    throw new LedgerError(`budget.estimateMicros must be a non-negative integer, got ${estimate}`)
  }
  const remainingMicros = Math.max(0, budget.limitMicros - spentMicros)
  return {
    allowed: !budget.hardCap || spentMicros + estimate <= budget.limitMicros,
    spentMicros,
    limitMicros: budget.limitMicros,
    remainingMicros,
    hardCap: budget.hardCap,
  }
}
