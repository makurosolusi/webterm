// One daily spending limit for all work (settings overhaul W2c): Central's "Daily spending limit"
// (`WEBTERM_CENTRAL_DAILY_COST_MICROS`, Settings › Central) is also the cap that stops routines, plans and
// bake-offs. The old separate "Pause all work at $" cap (`cost_cap` scope `day`) is merged into it once
// at boot: a lower old cap wins, then the old row is zeroed so only one limit remains.
import type { Database } from 'bun:sqlite'
import { execWrite, getRow } from '../ledger/ledgerCore'
import { budgetLimits } from '../central/guard/budgetStore'
import { ensureCostSchema } from './costStore'

export const CENTRAL_COST_KEY = 'WEBTERM_CENTRAL_DAILY_COST_MICROS'

const storedDayCap = (db: Database): number => Number(getRow(db, "SELECT limit_micros FROM cost_cap WHERE scope = 'day'")?.['limit_micros'] ?? 0)

/** The "all work today" cap in micros: the tighter of Central's limit and an old `day` cap not merged yet; 0 = none. */
export function dayCapMicros(db: Database, env: Record<string, string | undefined> = process.env): number {
  const caps = [storedDayCap(db), budgetLimits(env).costMicros].filter((c) => c > 0)
  return caps.length ? Math.min(...caps) : 0
}

/** Writes Central's limit; false = not saved (locked env, invalid), so the old cap must stay in force. */
export type WriteCentralLimit = (micros: number) => boolean

/**
 * Idempotent: `copied` = the old cap was lower (or Central had none) and became Central's limit;
 * `kept` = Central's limit was already tighter; `none` = no old cap; `failed` = could not write, old cap kept.
 */
export function mergeDayCapIntoCentral(db: Database, env: Record<string, string | undefined>, write: WriteCentralLimit): 'none' | 'copied' | 'kept' | 'failed' {
  ensureCostSchema(db)
  const old = storedDayCap(db)
  if (old <= 0) return 'none'
  const central = budgetLimits(env).costMicros
  const copy = central <= 0 || old < central
  if (copy && !write(old)) return 'failed'
  // Zeroed, not deleted: a paused `day` row keeps its pause until Resume or the next UTC day.
  execWrite(db, "UPDATE cost_cap SET limit_micros = 0 WHERE scope = 'day'")
  return copy ? 'copied' : 'kept'
}
