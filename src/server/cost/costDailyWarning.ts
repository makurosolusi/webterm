// Soft daily spend warning: once today's total spend (every source, UTC day) passes
// DAILY_COST_WARNING_MICROS, one Needs-you notify item is raised for that day. It never blocks work;
// the hard cap stays WEBTERM_CENTRAL_DAILY_COST_MICROS (0 = unlimited).
import type { Database } from 'bun:sqlite'
import { getRow } from '../ledger/ledgerCore'
import { createInboxItem } from '../inbox'
import { utcDay, utcDayStart } from '../central/guard/budgetStore'
import { DAILY_COST_WARNING_MICROS } from '../envRegistry.ca2'
import { spentMicros } from './costStore'

/** Raises today's warning when spend crossed the threshold; true only when a new item was created. */
export function warnDailyCost(db: Database, now: () => number = Date.now, thresholdMicros = DAILY_COST_WARNING_MICROS): boolean {
  const t = now()
  const key = `cost:day-warning:${utcDay(t)}`
  // Once per day even after the user dismissed it: any row with today's key (open or closed) counts.
  if (getRow(db, 'SELECT 1 AS one FROM inbox_item WHERE dedupe_key = ?', key)) return false
  const spent = spentMicros(db, { since: utcDayStart(t) }).costMicros
  if (spent < thresholdMicros) return false
  createInboxItem({ db, now }, {
    kind: 'notify', source: 'cost', dedupeKey: key,
    title: `Today's spend passed $${(thresholdMicros / 1e6).toFixed(0)}`,
    body: `Spend so far today (UTC): $${(spent / 1e6).toFixed(2)}. This is a warning only; nothing was stopped. Set a hard daily cap in Settings > Central (Daily cost budget).`,
  })
  return true
}
