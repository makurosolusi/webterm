// Daily usage counters in `central_budget` (UTC day, scope `global` or `project:<id>`) and the limits read from env.
import type { Database } from 'bun:sqlite'
import { execWrite, getRow, tx } from '../../ledger/ledgerCore'
import { CA2_ENV_SPECS } from '../../envRegistry.ca2'
import type { GuardUsage } from '../contracts/level.types'

/** Daily limits. `tokens`/`costMicros` 0 = unlimited; `spawns` 0 = no spawn allowed. */
export interface BudgetLimits { tokens: number; spawns: number; costMicros: number }
/** One day's counters for a scope. */
export interface Budget { turns: number; tokens: number; costMicros: number; spawns: number; wallMs: number }

const ISO_DAY_LENGTH = 10

/** UTC `YYYY-MM-DD` for an epoch-ms timestamp. */
export function utcDay(ts: number): string { return new Date(ts).toISOString().slice(0, ISO_DAY_LENGTH) }

function limitOf(env: Record<string, string | undefined>, key: string): number {
  const spec = CA2_ENV_SPECS.find((s) => s.key === key)
  const fallback = Number(spec?.default ?? 0)
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  const inRange = Number.isInteger(n) && n >= (spec?.min ?? 0) && n <= (spec?.max ?? Number.MAX_SAFE_INTEGER)
  return inRange ? n : fallback
}

/** Limits from `WEBTERM_CENTRAL_DAILY_{TOKENS,SPAWNS,COST_MICROS}`; invalid values fall back to the registry default. */
export function budgetLimits(env: Record<string, string | undefined>): BudgetLimits {
  return { tokens: limitOf(env, 'WEBTERM_CENTRAL_DAILY_TOKENS'), spawns: limitOf(env, 'WEBTERM_CENTRAL_DAILY_SPAWNS'), costMicros: limitOf(env, 'WEBTERM_CENTRAL_DAILY_COST_MICROS') }
}

/** Counters for `scope` on `day` (zeros when no row). */
export function readBudget(db: Database, day: string, scope: string): Budget {
  const r = getRow(db, 'SELECT turns, tokens, cost_micros, spawns, wall_ms FROM central_budget WHERE day = ? AND scope = ?', day, scope)
  return { turns: Number(r?.turns ?? 0), tokens: Number(r?.tokens ?? 0), costMicros: Number(r?.cost_micros ?? 0), spawns: Number(r?.spawns ?? 0), wallMs: Number(r?.wall_ms ?? 0) }
}

const UPSERT = `INSERT INTO central_budget (day, scope, turns, tokens, cost_micros, spawns, wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(day, scope) DO UPDATE SET turns = turns + excluded.turns, tokens = tokens + excluded.tokens,
  cost_micros = cost_micros + excluded.cost_micros, spawns = spawns + excluded.spawns, wall_ms = wall_ms + excluded.wall_ms`

function nonNegative(n: number): number { return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0 }

/** Adds usage to the global row and, when a project is named, to that project's row (one transaction). */
export function addUsage(db: Database, usage: GuardUsage, now: () => number): void {
  const day = utcDay(now())
  const vals = [nonNegative(usage.turns), nonNegative(usage.tokens), nonNegative(usage.costMicros), nonNegative(usage.spawns), nonNegative(usage.wallMs)]
  tx({ db, now }, () => {
    execWrite(db, UPSERT, day, 'global', ...vals)
    if (usage.projectId) execWrite(db, UPSERT, day, `project:${usage.projectId}`, ...vals)
  })
}

/** Why today's usage forbids more work, or null. Token/cost limits block everything costly; the spawn limit blocks spawns only. */
export function budgetExhausted(budget: Budget, limits: BudgetLimits, forSpawn: boolean): { code: 'budget_exhausted' | 'spawn_daily'; reason: string } | null {
  if (limits.tokens > 0 && budget.tokens >= limits.tokens) return { code: 'budget_exhausted', reason: `daily token budget used (${budget.tokens}/${limits.tokens})` }
  if (limits.costMicros > 0 && budget.costMicros >= limits.costMicros) return { code: 'budget_exhausted', reason: `daily cost budget used (${budget.costMicros}/${limits.costMicros})` }
  if (forSpawn && budget.spawns >= limits.spawns) return { code: 'spawn_daily', reason: `daily spawn limit reached (${budget.spawns}/${limits.spawns})` }
  return null
}
