// Startup wiring for the P2 ledger. Flag default OFF so existing installs are untouched.
// `shadow` opens and migrates the ledger but must never fail the server; `on` is strict.
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { dataDir } from '../config'
import { createLedger, type Ledger } from './ledger'
import { openLedgerDb } from './migration'

export type LedgerMode = 'off' | 'shadow' | 'on'

export interface LedgerRuntime {
  mode: Exclude<LedgerMode, 'off'>
  path: string
  db: Database
  ledger: Ledger
  close(): void
}

export function ledgerMode(raw = process.env.WEBTERM_LEDGER): LedgerMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'on' || value === 'shadow') return value
  return 'off'
}

/**
 * Opens + migrates the ledger. Returns null when the flag is off, or when shadow mode cannot
 * open the file (a broken shadow ledger must not take the terminal server down).
 */
export function startLedgerRuntime(opts: {
  mode?: LedgerMode
  path?: string
  now?: number | (() => number)
} = {}): LedgerRuntime | null {
  const mode = opts.mode ?? ledgerMode()
  if (mode === 'off') return null
  const path = opts.path ?? join(dataDir(), 'ledger.db')
  try {
    const db = openLedgerDb(path)
    const ledger = createLedger(db, { now: opts.now })
    return {
      mode,
      path,
      db,
      ledger,
      close: () => (db as unknown as { close(): void }).close(),
    }
  } catch (err) {
    if (mode === 'on') throw err
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`ledger shadow disabled: ${reason}`)
    return null
  }
}

/**
 * Periodic reaper. Unref'd so a ledger sweep never keeps the process alive; errors are reported
 * and swallowed because one bad tick must not kill the timer.
 */
export function startLedgerReaper(
  ledger: { task: { sweepExpiredLeases(limit?: number, now?: number): unknown } },
  intervalMs = 30_000,
  onError: (err: unknown) => void = (err) => {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`ledger reaper tick failed: ${reason}`)
  }
): () => void {
  const timer = setInterval(() => {
    try {
      ledger.task.sweepExpiredLeases()
    } catch (err) {
      onError(err)
    }
  }, intervalMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
