// Bun-only (bun:sqlite): the soft $10/day spend warning is off by default (Settings `dailySpendWarning`); on, it
// raises one Needs-you notice per UTC day; off, open warnings and spend-only digests close once with one notice.
// Temp HOME / data dir / Claude dir: nothing here may touch the user's real files.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'cost-warn-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.WEBTERM_CENTRAL_RUNTIME = 'mock' // test-only: notices publish on the mock runtime's stream hub

const { openLedgerDb } = await import('../ledger/migration')
const { execWrite } = await import('../ledger/ledgerCore')
const { ensureCostSchema, insertCostUsage } = await import('./costStore')
const { closeSpendWarnings, warnDailyCost } = await import('./costDailyWarning')
const { createInboxItem } = await import('../inbox')
const { DAILY_COST_WARNING_MICROS } = await import('../envRegistry.ca2')
const { budgetLimits } = await import('../central/guard/budgetStore')
const { DEFAULT_SETTINGS } = await import('../../shared/settings')
type AppendEventInput = import('../events/eventModel').AppendEventInput

afterAll(() => rmSync(root, { recursive: true, force: true }))

const DAY0 = Date.parse('2026-11-08T12:00:00.000Z')
const DAY = 24 * 60 * 60_000

function fresh() {
  const db = openLedgerDb(':memory:')
  ensureCostSchema(db)
  let seq = 0
  const spend = (ts: number, costMicros: number) => insertCostUsage(db, {
    key: `k${++seq}`, ts, source: 'agent', workspaceId: null, nodeId: null, sessionId: null, model: 'claude-opus-5-5',
    input: 1, output: 1, cacheRead: 0, write5m: 0, write1h: 0, costMicros,
  })
  const items = (where = "source = 'cost'") => db.query(`SELECT title, kind, status FROM inbox_item WHERE ${where}`).all() as Array<Record<string, unknown>>
  return { db, spend, items }
}

test('defaults: spend warning off, no daily token cap, $10 threshold, no hard cost cap', () => {
  expect(DEFAULT_SETTINGS.dailySpendWarning).toBe(false)
  expect(budgetLimits({})).toMatchObject({ tokens: 0, costMicros: 0 })
  expect(DAILY_COST_WARNING_MICROS).toBe(10_000_000)
})

test('off: spend over the threshold creates no item', () => {
  const { db, spend, items } = fresh()
  spend(DAY0, 50_000_000)
  expect(warnDailyCost(db, { enabled: false, now: () => DAY0 + 1 })).toBe(false)
  expect(items()).toEqual([])
})

test('on: nothing below it, one notice once crossed, none again that day, a new one the next day', () => {
  const { db, spend, items } = fresh()
  const warn = (t: number) => warnDailyCost(db, { enabled: true, now: () => t })
  spend(DAY0 - DAY, 50_000_000) // yesterday's spend does not count today
  spend(DAY0, 9_000_000)
  expect(warn(DAY0)).toBe(false)
  spend(DAY0 + 1, 2_000_000)
  expect(warn(DAY0 + 2)).toBe(true)
  expect(items()).toEqual([{ title: "Today's spend passed $10", kind: 'notify', status: 'open' }])

  execWrite(db, "UPDATE inbox_item SET status = 'done' WHERE source = 'cost'") // the user dismissed it
  spend(DAY0 + 3, 5_000_000)
  expect(warn(DAY0 + 4)).toBe(false)
  expect(items()).toHaveLength(1)

  spend(DAY0 + DAY, 11_000_000)
  expect(warn(DAY0 + DAY + 1)).toBe(true)
  expect(items()).toHaveLength(2)
})

test('off: open warnings and spend-only digests close once, with one notice and record; a second run does nothing', () => {
  const { db, spend, items } = fresh()
  const ctx = { db, now: () => DAY0 }
  spend(DAY0 - DAY, 15_000_000)
  spend(DAY0, 15_000_000)
  warnDailyCost(db, { enabled: true, now: () => DAY0 - DAY })
  warnDailyCost(db, { enabled: true, now: () => DAY0 })
  createInboxItem(ctx, { kind: 'notify', source: 'digest', title: 'Daily digest: 1 update', body: "- Today's spend passed $10", dedupeKey: 'digest:a' })
  createInboxItem(ctx, { kind: 'notify', source: 'digest', title: 'Daily digest: 2 updates', body: "- Today's spend passed $10\n- Build finished", dedupeKey: 'digest:b' })
  createInboxItem(ctx, { kind: 'notify', source: 'agent', title: 'Build finished' })

  const records: AppendEventInput[] = []
  const deps = { now: () => DAY0 + 5, record: (e: AppendEventInput) => { records.push(e) } }
  expect(closeSpendWarnings(db, deps)).toBe(3)
  expect(items().map((i) => i['status'])).toEqual(['done', 'done'])
  expect(items("source = 'digest'").map((i) => [i['title'], i['status']])).toEqual([['Daily digest: 1 update', 'done'], ['Daily digest: 2 updates', 'open']])
  expect(items("source = 'agent'")[0]?.['status']).toBe('open')
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ kind: 'auto.cost.spend-warnings-off' })
  expect(String((records[0]!.payload as { text: string }).text)).toBe('Spend warnings are off; closed 2 open warnings and 1 digest that only listed them. Turn them back on in Settings > Central.')
  const notices = db.query("SELECT parts_json FROM central_message WHERE role = 'system'").all() as Array<{ parts_json: string }>
  expect(notices.filter((n) => n.parts_json.includes('Spend warnings are off'))).toHaveLength(1)

  expect(closeSpendWarnings(db, deps)).toBe(0)
  expect(records).toHaveLength(1)
})
