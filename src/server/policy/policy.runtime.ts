// Process-wide policy over the active ledger DB, cached per DB handle (same seam as
// events/eventsRuntime.ts). Null when the ledger is off: callers then keep their pre-policy behaviour.
import type { Database } from 'bun:sqlite'
import { activeEventLog } from '../events/eventsRuntime'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createPolicy, type Policy } from './policy.decide'

let cached: { db: Database; policy: Policy } | null = null

export function activePolicy(): Policy | null {
  const ledger = activeLedgerRuntime()
  if (!ledger) return null
  if (cached?.db !== ledger.db) {
    const events = activeEventLog()
    cached = { db: ledger.db, policy: createPolicy({ db: ledger.db, ...(events ? { events } : {}) }) }
  }
  return cached.policy
}

/** Test hook. */
export function resetActivePolicyForTest(): void {
  cached = null
}
