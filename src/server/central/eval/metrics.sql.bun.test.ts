// Bun-only (bun:sqlite). Seeds central_turn rows and checks every metric against hand-computed values.
import { expect, test } from 'bun:test'
import { execWrite } from '../../ledger/ledgerCore'
import { openLedgerDb } from '../../ledger/migration'
import { computeMetrics } from './metrics.sql'

const HOUR = 3_600_000
const BASE = 1_000_000 // test-only

function seededDb() {
  const db = openLedgerDb(':memory:')
  let n = 0
  const add = (startOffset: number, durationMs: number | null, errorCode: string | null, usage: object | null) => {
    n += 1
    execWrite(
      db,
      `INSERT INTO central_turn (id, conversation_id, message_id, status, usage_json, error_code, started_at, ended_at)
       VALUES (?, 'c', ?, 'x', ?, ?, ?, ?)`,
      `t${n}`, `m${n}`, usage === null ? null : JSON.stringify(usage), errorCode,
      BASE + startOffset, durationMs === null ? null : BASE + startOffset + durationMs
    )
  }
  // 10 finished turns with durations 100..1000, one of them interrupted (unfinished), one timeout.
  for (let i = 1; i <= 8; i += 1) add(i * 10, i * 100, null, { inputTokens: 100, cacheReadTokens: 300 })
  add(90, 900, 'timeout', null)
  add(100, 1000, 'budget_exhausted', null)
  add(110, null, 'interrupted', null)
  add(HOUR * 5, 50, null, null) // outside the window
  return db
}

test('metrics: counts, nearest-rank p95, error ratios, cache hit ratio and interrupted', () => {
  const db = seededDb()
  const m = computeMetrics(db, { sinceMs: BASE, untilMs: BASE + HOUR / 2 })
  expect(m.turns).toBe(11)
  expect(m.turnsPerHour).toBe(22)
  // 10 finished durations sorted: 100..800, 900, 1000 -> rank ceil(0.95*10)=10 -> 1000.
  expect(m.p95Ms).toBe(1000)
  expect(m.errorCodeRatio['timeout']).toBe(1 / 11)
  expect(m.errorCodeRatio['interrupted']).toBe(1 / 11)
  expect(m.errorCodeRatio['budget_exhausted']).toBe(1 / 11)
  expect(Object.keys(m.errorCodeRatio).length).toBe(3)
  expect(m.cacheHitRatio).toBe(0.75)
  expect(m.interrupted).toBe(1)
})

test('metrics: empty ledger window yields null p95/cache ratios and zero counts', () => {
  const db = seededDb()
  const m = computeMetrics(db, { sinceMs: BASE + HOUR * 10, untilMs: BASE + HOUR * 11 })
  expect(m.turns).toBe(0)
  expect(m.p95Ms).toBe(null)
  expect(m.cacheHitRatio).toBe(null)
  expect(m.interrupted).toBe(0)
})

test('metrics: an inverted window throws instead of dividing by zero', () => {
  const db = seededDb()
  let message = ''
  try {
    computeMetrics(db, { sinceMs: BASE, untilMs: BASE })
  } catch (error) {
    message = String(error)
  }
  expect(message).toContain('until > since')
})
