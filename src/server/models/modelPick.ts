// The model ladder with live inputs: today's spend against the daily cost cap, the per-project
// override, and one Inbox notice when budget pressure pulls a T3+ run down. Callers that hold no
// ledger pass `db: null`: the override still applies, the budget does not (nothing is measured).
import type { Database } from 'bun:sqlite'
import { getRow } from '../ledger/ledgerCore'
import { createInboxItem } from '../inbox/inboxItemStore'
import { scopeSpent } from '../cost/costOracle'
import { ensureCostSchema } from '../cost/costStore'
import { budgetLimits } from '../central/guard/budgetStore'
import { createLogger } from '../logs'
import { TIER_TABLE, defaultTier, resolveModel, type ModelPick, type ResolveInput } from './modelLadder'
import { projectModelOverride } from './modelOverride'

const log = createLogger('models')
export const MODEL_NOTICE_SOURCE = 'models'
const HIGH_TIERS = new Set(['T3', 'T4'])

export interface PickInput extends Pick<ResolveInput, 'kind' | 'complexity' | 'attempt' | 'lastFailure'> {
  /** Key of `projectModels` to read the override from (project or workspace id). */
  scopeId?: string | null
  /** Idempotency key of the budget notice: one open notice per run ref. */
  runRef: string
  workspaceId?: string | null
  projectId?: string | null
}

/**
 * Today's spend and the daily cap: the tighter of the cost oracle's `day` cap and the Central daily cost
 * budget (`WEBTERM_CENTRAL_DAILY_COST_MICROS`, Settings > Central); 0 = neither is set.
 */
export function dailyBudget(db: Database, now: number, env: Record<string, string | undefined> = process.env): { spentMicros: number; capMicros: number } {
  ensureCostSchema(db)
  const caps = [Number(getRow(db, "SELECT limit_micros FROM cost_cap WHERE scope = 'day'")?.['limit_micros'] ?? 0), budgetLimits(env).costMicros].filter((c) => c > 0)
  const capMicros = caps.length ? Math.min(...caps) : 0
  return { spentMicros: capMicros > 0 ? scopeSpent(db, 'day', now) : 0, capMicros }
}

export function pickModel(db: Database | null, input: PickInput, now: () => number = Date.now): ModelPick {
  const override = projectModelOverride(input.scopeId ?? input.projectId ?? input.workspaceId)
  const budget = db ? dailyBudget(db, now()) : {}
  const pick = resolveModel({ kind: input.kind, complexity: input.complexity, attempt: input.attempt, lastFailure: input.lastFailure, override, ...budget })
  const base = defaultTier(input.kind, input.complexity)
  if (db && pick.reason.startsWith('budget:') && HIGH_TIERS.has(base)) {
    try {
      createInboxItem({ db, now }, {
        kind: 'notify', source: MODEL_NOTICE_SOURCE, workspaceId: input.workspaceId ?? null, projectId: input.projectId ?? null,
        title: 'Run limited by the daily cost cap',
        body: `A ${input.kind} run would normally use ${TIER_TABLE[base].model} but ran on ${pick.model ?? 'the CLI default'} (${pick.reason}). Raise the daily cap in Settings or wait for the UTC day to end.`,
        dedupeKey: `model-budget:${input.runRef}`,
      })
    } catch (err) {
      // The notice is advisory; the run itself must still start on the capped model.
      log.warn('models.notice_failed', `Cannot write the budget notice for ${input.runRef}`, { cause: err instanceof Error ? err.message : String(err) })
    }
  }
  return pick
}
