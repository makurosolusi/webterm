import { describe, expect, it } from 'vitest'
import { LedgerMetrics } from './ledgerMetrics'

describe('LedgerMetrics', () => {
  it('counts events and aggregates timings', () => {
    const m = new LedgerMetrics()
    m.inc('lease_expired')
    m.inc('lease_expired', 2)
    m.observe('migration_ms', 10)
    m.observe('migration_ms', 30)
    const snap = m.snapshot()
    expect(snap.counters['lease_expired']).toBe(3)
    expect(snap.timings['migration_ms']).toEqual({ count: 2, totalMs: 40, maxMs: 30 })
  })

  it('reset clears both maps', () => {
    const m = new LedgerMetrics()
    m.inc('suspect')
    m.observe('migration_ms', 1)
    m.reset()
    expect(m.snapshot()).toEqual({ counters: {}, timings: {} })
  })
})
