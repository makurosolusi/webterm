// Bun-only (bun:sqlite): the soft $10/day spend warning raises one Needs-you notice per UTC day.
import { expect, test } from 'bun:test'
import { openLedgerDb } from '../ledger/migration'
import { execWrite } from '../ledger/ledgerCore'
import { ensureCostSchema, insertCostUsage } from './costStore'
import { warnDailyCost } from './costDailyWarning'
import { DAILY_COST_WARNING_MICROS } from '../envRegistry.ca2'
import { budgetLimits } from '../central/guard/budgetStore'

const DAY0 = Date.parse('2026-11-08T12:00:00.000Z')
const DAY = 24 * 60 * 60_000

test('defaults: 10M daily tokens, $10 warning, no hard cost cap', () => {
  expect(budgetLimits({})).toMatchObject({ tokens: 10_000_000, costMicros: 0 })
  expect(DAILY_COST_WARNING_MICROS).toBe(10_000_000)
})

test('$10 warning: nothing below it, one notice once crossed, none again that day, a new one the next day', () => {
  const db = openLedgerDb(':memory:')
  ensureCostSchema(db)
  let seq = 0
  const spend = (ts: number, costMicros: number) => insertCostUsage(db, {
    key: `k${++seq}`, ts, source: 'agent', workspaceId: null, nodeId: null, sessionId: null, model: 'claude-opus-5-5',
    input: 1, output: 1, cacheRead: 0, write5m: 0, write1h: 0, costMicros,
  })
  const notices = () => db.query("SELECT title, kind, status FROM inbox_item WHERE source = 'cost'").all() as Array<Record<string, unknown>>

  spend(DAY0 - DAY, 50_000_000) // yesterday's spend does not count today
  spend(DAY0, 9_000_000)
  expect(warnDailyCost(db, () => DAY0)).toBe(false)
  spend(DAY0 + 1, 2_000_000)
  expect(warnDailyCost(db, () => DAY0 + 2)).toBe(true)
  expect(notices()).toEqual([{ title: "Today's spend passed $10", kind: 'notify', status: 'open' }])

  execWrite(db, "UPDATE inbox_item SET status = 'done' WHERE source = 'cost'") // the user dismissed it
  spend(DAY0 + 3, 5_000_000)
  expect(warnDailyCost(db, () => DAY0 + 4)).toBe(false)
  expect(notices()).toHaveLength(1)

  spend(DAY0 + DAY, 11_000_000)
  expect(warnDailyCost(db, () => DAY0 + DAY + 1)).toBe(true)
  expect(notices()).toHaveLength(2)
})
