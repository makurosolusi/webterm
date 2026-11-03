// Startup wiring for the P2 ledger. Selalu hidup (ENVSIMPLE KE-1); `WEBTERM_LEDGER_SHADOW=1` = shadow.
// `shadow` opens and migrates the ledger but must never fail the server; an explicit `on` is strict.
import type { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dataDir } from '../config'
import { createLedger, type Ledger } from './ledger'
import { openLedgerDb } from './migration'
import { ledgerMetrics } from './ledgerMetrics'
import { setActiveLedgerRuntime } from './ledgerRuntimeState'
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

/**
 * Periodic reaper. Unref'd so a ledger sweep never keeps the process alive; errors are reported
 * and swallowed because one bad tick must not kill the timer.
 */
export function startLedgerReaper(
  ledger: { task: { sweepExpiredLeases(limit?: number, now?: number): unknown } },
  intervalMs = 30_000,
  onError: (err: unknown) => void = (err) => {
    const reason = err instanceof Error ? err.message : String(err)
    log.error('ledger.reaper.error', `ledger reaper tick failed: ${reason}`)
  }
): () => void {
  log.info('ledger.reaper.start', 'ledger reaper started', { intervalMs })
  const timer = setInterval(() => {
    ledgerMetrics.inc('reaper_tick')
    try {
      ledger.task.sweepExpiredLeases()
    } catch (err) {
      ledgerMetrics.inc('reaper_error')
      onError(err)
    }
  }, intervalMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => {
    clearInterval(timer)
    log.info('ledger.reaper.stop', 'ledger reaper stopped')
  }
}
