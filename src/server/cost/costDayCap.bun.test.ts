// One daily limit: Central's WEBTERM_CENTRAL_DAILY_COST_MICROS also stops routines/plans, and the retired
// "Pause all work" cap (cost_cap scope `day`) is folded into it once (lower wins), on the real ledger schema.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openLedgerDb } from '../ledger/migration'
import { CENTRAL_COST_KEY, dayCapMicros, mergeDayCapIntoCentral } from './costDayCap'
import { costGate, listCaps, setCostCap } from './costOracle'
import { insertCostUsage } from './costStore'

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0) // test-only clock
let db: Database
const prev = process.env[CENTRAL_COST_KEY]
beforeEach(() => { db = openLedgerDb(':memory:'); delete process.env[CENTRAL_COST_KEY] })
afterEach(() => { db.close(); if (prev === undefined) delete process.env[CENTRAL_COST_KEY]; else process.env[CENTRAL_COST_KEY] = prev })

const merge = (env: Record<string, string>, ok = true) => {
  const writes: number[] = []
  const out = mergeDayCapIntoCentral(db, env, (m) => { writes.push(m); return ok })
  return { out, writes }
}

test('old cap lower than Central (or Central unset) is copied once, then zeroed', () => {
  setCostCap(db, 'day', 2_000_000)
  expect(merge({ [CENTRAL_COST_KEY]: '5000000' })).toEqual({ out: 'copied', writes: [2_000_000] })
  expect(dayCapMicros(db, {})).toBe(0)
  expect(merge({})).toEqual({ out: 'none', writes: [] }) // second boot: nothing left to merge
  setCostCap(db, 'day', 3_000_000)
  expect(merge({})).toEqual({ out: 'copied', writes: [3_000_000] })
})

test('Central already tighter: kept, old cap still zeroed; a failed write keeps the old cap in force', () => {
  setCostCap(db, 'day', 9_000_000)
  expect(merge({ [CENTRAL_COST_KEY]: '1000000' })).toEqual({ out: 'kept', writes: [] })
  expect(dayCapMicros(db, {})).toBe(0)
  setCostCap(db, 'day', 500_000)
  expect(merge({}, false).out).toBe('failed')
  expect(dayCapMicros(db, {})).toBe(500_000)
})

test('Central’s limit stops routines and plans too, and the caps list reports it', () => {
  insertCostUsage(db, { key: 'u1', ts: T0, source: 'agent', workspaceId: 'w1', nodeId: 'n1', sessionId: null, model: 'claude-opus-5-5', input: 10, output: 10, cacheRead: 0, write5m: 0, write1h: 0, costMicros: 2_000_000 })
  setCostCap(db, 'day', 0)
  expect(costGate(db, { kind: 'routine', ref: 'r1' }, () => T0 + 1, () => {}).allowed).toBe(true)
  process.env[CENTRAL_COST_KEY] = '1000000'
  expect(costGate(db, { kind: 'routine', ref: 'r1' }, () => T0 + 1, () => {}).allowed).toBe(false)
  expect(listCaps(db, T0 + 1).find((c) => c.scope === 'day')?.limitMicros).toBe(1_000_000)
})
