// Process-wide handle to the ledger runtime opened by `startLedgerRuntime`. Kept in its own
// module because `ledgerRuntime.ts` imports `bun:sqlite` (through `migration.ts`) and node-env
// vitest must be able to read the handle (mount/approval tests) without loading that module.
import type { LedgerRuntime } from './ledgerRuntime'

let active: LedgerRuntime | null = null

/** The runtime started in this process, or null when the flag is off / shadow failed. */
export function activeLedgerRuntime(): LedgerRuntime | null {
  return active
}

/** Called by `startLedgerRuntime`; exposed so tests can point the seam at a fake runtime. */
export function setActiveLedgerRuntime(runtime: LedgerRuntime | null): void {
  active = runtime
}

/** Test hook: forget the process runtime between cases. */
export function resetActiveLedgerRuntimeForTest(): void {
  active = null
}
