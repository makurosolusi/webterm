// Soft daily spend warning (Settings `dailySpendWarning`, off by default): once today's total spend (every source,
// UTC day) passes DAILY_COST_WARNING_MICROS, one Needs-you notify item is raised for that day. It never blocks
// work; the hard cap stays WEBTERM_CENTRAL_DAILY_COST_MICROS (0 = unlimited). With the setting off, the open
// warnings (and digests that only re-listed them) are closed once, told to the user through `automaticAction`.
import type { Database } from 'bun:sqlite'
import { allRows, getRow } from '../ledger/ledgerCore'
import { createInboxItem } from '../inbox'
import { resolveItem } from '../inbox/inboxItemStore'
import { utcDay, utcDayStart } from '../central/guard/budgetStore'
import { automaticAction, type AutomaticActionDeps } from '../central/automaticAction'
import { DAILY_COST_WARNING_MICROS } from '../envRegistry.ca2'
import { spentMicros } from './costStore'

const KEY_PREFIX = 'cost:day-warning:'
const TITLE_PREFIX = "Today's spend passed $"

export interface WarnOptions {
  /** Settings `dailySpendWarning`; false = never creates an item. */
  enabled: boolean
  now?: () => number
  thresholdMicros?: number
}

/** Raises today's warning when enabled and spend crossed the threshold; true only when a new item was created. */
export function warnDailyCost(db: Database, { enabled, now = Date.now, thresholdMicros = DAILY_COST_WARNING_MICROS }: WarnOptions): boolean {
  if (!enabled) return false
  const t = now()
  const key = `${KEY_PREFIX}${utcDay(t)}`
  // Once per day even after the user dismissed it: any row with today's key (open or closed) counts.
  if (getRow(db, 'SELECT 1 AS one FROM inbox_item WHERE dedupe_key = ?', key)) return false
  const spent = spentMicros(db, { since: utcDayStart(t) }).costMicros
  if (spent < thresholdMicros) return false
  createInboxItem({ db, now }, {
    kind: 'notify', source: 'cost', dedupeKey: key,
    title: `${TITLE_PREFIX}${(thresholdMicros / 1e6).toFixed(0)}`,
    body: `Spend so far today (UTC): $${(spent / 1e6).toFixed(2)}. This is a warning only; nothing was stopped. Set a hard daily cap in Settings > Central (Daily cost budget).`,
  })
  return true
}

/** A digest whose every line is a spend warning (older digests listed them; see ensureDailyDigest). */
const onlySpendLines = (body: unknown): boolean => {
  const lines = String(body ?? '').split('\n').filter((l) => l.trim())
  return lines.length > 0 && lines.every((l) => l.startsWith(`- ${TITLE_PREFIX}`))
}

/** Setting off: closes open spend warnings and spend-only digests, with one notice + record. Returns how many. */
export function closeSpendWarnings(db: Database, deps: Omit<AutomaticActionDeps, 'db'> = {}): number {
  const ctx = { db, now: deps.now ?? Date.now }
  const warnings = allRows(db, "SELECT id FROM inbox_item WHERE status = 'open' AND source = 'cost' AND substr(dedupe_key, 1, ?) = ?", KEY_PREFIX.length, KEY_PREFIX)
  const digests = allRows(db, "SELECT id, body FROM inbox_item WHERE status = 'open' AND source = 'digest'").filter((r) => onlySpendLines(r['body']))
  const ids = [...warnings, ...digests].map((r) => String(r['id']))
  if (ids.length === 0) return 0
  for (const id of ids) resolveItem(ctx, id, { status: 'done', resolution: 'spend-warning-off', by: 'system:cost' })
  automaticAction({ ...deps, db }, {
    name: 'cost.spend-warnings-off', actor: 'system:cost', subject: ids[0],
    text: `Spend warnings are off; closed ${warnings.length} open warning${warnings.length === 1 ? '' : 's'}${digests.length ? ` and ${digests.length} digest${digests.length === 1 ? '' : 's'} that only listed them` : ''}. Turn them back on in Settings > Central.`,
  })
  return ids.length
}
