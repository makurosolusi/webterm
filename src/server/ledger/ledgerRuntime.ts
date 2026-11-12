// Startup wiring for the P2 ledger. Selalu hidup (ENVSIMPLE KE-1); `WEBTERM_LEDGER_SHADOW=1` = shadow.
// `shadow` opens and migrates the ledger but must never fail the server; an explicit `on` is strict.
import type { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dataDir } from '../config'
import { createLedger, type Ledger } from './ledger'
import { openLedgerDb } from './migration'
import { ledgerMetrics } from './ledgerMetrics'
import { activeLedgerRuntime, setActiveLedgerRuntime } from './ledgerRuntimeState'
import { createLogger } from '../logs'
import { flagOn } from '../envFlag'

// The HTTP layer reads the runtime through this handle; startLedgerRuntime owns the value.
export {
  activeLedgerRuntime,
  resetActiveLedgerRuntimeForTest,
} from './ledgerRuntimeState'

export type LedgerMode = 'off' | 'shadow' | 'on'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
/** SQLite creates these next to the database; all of them can hold ledger bytes. */
const LEDGER_FILES = ['', '-wal', '-shm', '-journal'] as const

const log = createLogger('ledger')

function isMemoryPath(path: string): boolean {
  return path === '' || path === ':memory:' || path.startsWith('file::memory:')
}

function warnPermissions(what: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  log.warn('ledger.permissions', `ledger ${what} permissions not enforced: ${reason}`, { what })
}

/**
 * The ledger holds approval nonces and `request_json` payloads, so the file must be as private as
 * the channel store (RND/qc/p3-security.md L2): directory 0700, database and WAL/SHM sidecars
 * 0600. Called before open (a 0700 dir already hides a default-mode file) and after migrate (WAL
 * and SHM only exist once SQLite has written them).
 *
 * Never throws: a permission failure must not take a running server down in shadow mode, and the
 * caller that needs strictness is the boot path in `on` mode.
 */
export function hardenLedgerPermissions(path: string): void {
  if (isMemoryPath(path)) return
  const dir = dirname(path)
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
    // mkdir's mode is filtered by umask, so assert the final mode explicitly.
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, PRIVATE_DIR_MODE)
  } catch (err) {
    warnPermissions('data dir', err)
  }
  for (const suffix of LEDGER_FILES) {
    const file = `${path}${suffix}`
    try {
      if (existsSync(file)) chmodSync(file, PRIVATE_FILE_MODE)
    } catch (err) {
      warnPermissions('file', err)
    }
  }
}

export interface LedgerRuntime {
  mode: Exclude<LedgerMode, 'off'>
  path: string
  db: Database
  ledger: Ledger
  close(): void
}

/** Env pengembang: ledger hanya shadow (gagal buka tak menjatuhkan server). */
export const LEDGER_SHADOW_FLAG = 'WEBTERM_LEDGER_SHADOW'

/** Mode ledger: selalu `on`, kecuali `WEBTERM_LEDGER_SHADOW` hidup => `shadow`. Kunci `WEBTERM_LEDGER` lama diabaikan. */
export function ledgerMode(raw = process.env[LEDGER_SHADOW_FLAG]): LedgerMode {
  return flagOn(raw) ? 'shadow' : 'on'
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
  if (mode === 'off') {
    setActiveLedgerRuntime(null)
    return null
  }
  const path = opts.path ?? join(dataDir(), 'ledger.db')
  try {
    hardenLedgerPermissions(path)
    const db = openLedgerDb(path)
    // WAL/SHM are created by the pragma/migration above; tighten them too.
    hardenLedgerPermissions(path)
    const ledger = createLedger(db, { now: opts.now })
    const runtime: LedgerRuntime = {
      mode,
      path,
      db,
      ledger,
      close: () => {
        // A closed runtime must stop being "the active one": process-wide seams (events, policy)
        // read the handle and would otherwise hand callers a closed DB.
        if (activeLedgerRuntime() === runtime) setActiveLedgerRuntime(null)
        ;(db as unknown as { close(): void }).close()
        log.info('ledger.stop', 'ledger runtime closed', { mode })
      },
    }
    setActiveLedgerRuntime(runtime)
    log.info('ledger.start', `ledger runtime started (${mode})`, { mode, db: basename(path) })
    return runtime
  } catch (err) {
    setActiveLedgerRuntime(null)
    // Mode eksplisit `on` (tes/pemanggil) tetap ketat; default turunan degradasi dengan warn (KE-1).
    if (mode === 'on' && opts.mode === 'on') throw err
    const reason = err instanceof Error ? err.message : String(err)
    log.error('ledger.error', `ledger disabled (${mode}): ${reason}`, { mode })
    return null
  }
}

/** What the reaper needs: lease sweep and, optionally, the throttled retention registry. */
export interface ReaperLedger {
  task: { sweepExpiredLeases(limit?: number, now?: number): unknown }
  retention?: { tick(now?: number): { changed: Record<string, number>; more: boolean } | null }
  /** File-manager trash sweep (fsBoot.ts createTrashReaper); throttles itself and never throws. */
  trash?: { tick(now?: number): unknown }
  /** Told what a retention sweep removed (only when something was); the Central notice lives outside the ledger. */
  onRetention?(changed: Record<string, number>): void
}

/**
 * Periodic reaper. Unref'd so a ledger sweep never keeps the process alive; errors are reported
 * and swallowed because one bad tick must not kill the timer. Lease sweep and retention fail
 * independently, so a broken retention sweep never stops expired leases from being reclaimed.
 */
export function startLedgerReaper(
  ledger: ReaperLedger,
  intervalMs = 30_000,
  onError: (err: unknown) => void = (err) => {
    const reason = err instanceof Error ? err.message : String(err)
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    log.error('ledger.reaper.error', `ledger reaper tick failed: ${reason}${cause}`)
  }
): () => void {
  log.info('ledger.reaper.start', 'ledger reaper started', { intervalMs })
  const guarded = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      ledgerMetrics.inc('reaper_error')
      onError(err)
    }
  }
  const timer = setInterval(() => {
    ledgerMetrics.inc('reaper_tick')
    guarded(() => ledger.task.sweepExpiredLeases())
    guarded(() => {
      const report = ledger.retention?.tick()
      if (!report || Object.keys(report.changed).length === 0) return
      const rows = Object.values(report.changed).reduce((a, b) => a + b, 0)
      ledgerMetrics.inc('retention_rows', rows)
      log.info('ledger.retention', 'ledger retention swept old rows', { ...report.changed, backlog: report.more })
      ledger.onRetention?.(report.changed)
    })
    guarded(() => ledger.trash?.tick())
  }, intervalMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => {
    clearInterval(timer)
    log.info('ledger.reaper.stop', 'ledger reaper stopped')
  }
}
