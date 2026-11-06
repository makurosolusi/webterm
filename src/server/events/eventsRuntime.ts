// Process-wide Senses log over the active ledger DB. Producers (F1-d) call `activeEventLog()`;
// null means the ledger failed to open (shadow mode), so they skip recording.
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { dataDir } from '../config'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'
import { eventBus } from './eventBus'
import { createEventLog, type EventLog } from './eventLog'
import { ANCHOR_FILE, anchorStatus, createAnchorWriter, readAnchor, type AnchorStatus } from './eventAnchor'

const log = createLogger('events')

export interface EventsRuntime {
  log: EventLog
  anchorFile: string
  /** Anchor status found when this runtime started; anything but match/no_anchor/pruned is a divergence. */
  startStatus: AnchorStatus | 'unreadable'
  /** Where the divergent anchor was preserved, if any. */
  divergedAnchorFile: string | null
  flushAnchor(): void
  stop(): void
}

/**
 * Builds the log + anchor writer for `db`. On a divergent anchor the old file is preserved under a
 * `.diverged-<ts>` name (evidence is never overwritten), an error is logged, and anchoring resumes.
 */
export function startEventsRuntime(db: Database, anchorFile = join(dataDir(), ANCHOR_FILE), now: () => number = Date.now): EventsRuntime {
  let writer: ReturnType<typeof createAnchorWriter> | null = null
  const eventLog = createEventLog(db, { now, bus: eventBus, onAppend: () => writer?.schedule() })
  writer = createAnchorWriter(anchorFile, () => eventLog.head(), (err) => {
    log.error('events.anchor.error', `event anchor write failed: ${err instanceof Error ? err.message : String(err)}`)
  }, undefined, now)
  let startStatus: EventsRuntime['startStatus']
  try {
    startStatus = anchorStatus(readAnchor(anchorFile), (seq) => eventLog.hashAt(seq), eventLog.prunedThrough())
  } catch (err) {
    startStatus = 'unreadable'
    log.error('events.anchor.unreadable', `event anchor unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  let divergedAnchorFile: string | null = null
  if (startStatus === 'rewritten' || startStatus === 'truncated' || startStatus === 'unreadable') {
    divergedAnchorFile = `${anchorFile}.diverged-${now()}`
    try {
      renameSync(anchorFile, divergedAnchorFile)
    } catch (err) {
      log.error('events.anchor.preserve', `cannot preserve divergent anchor: ${err instanceof Error ? err.message : String(err)}`)
      divergedAnchorFile = null
    }
    log.error('events.anchor.diverged', `event log no longer matches its anchor (${startStatus}); old anchor kept`, { status: startStatus })
  }
  if (startStatus !== 'match') writer.flush()
  const flushAnchor = writer.flush
  const stopWriter = writer.stop
  return { log: eventLog, anchorFile, startStatus, divergedAnchorFile, flushAnchor, stop: stopWriter }
}

let cached: { db: Database; runtime: EventsRuntime } | null = null

/** Runtime bound to the active ledger DB (created on first use), or null when the ledger is off. */
export function activeEventsRuntime(): EventsRuntime | null {
  const ledger = activeLedgerRuntime()
  if (!ledger) return null
  if (cached?.db !== ledger.db) {
    cached?.runtime.stop()
    cached = { db: ledger.db, runtime: startEventsRuntime(ledger.db) }
  }
  return cached.runtime
}

/** The process event log for producers; null when there is no ledger. */
export function activeEventLog(): EventLog | null {
  return activeEventsRuntime()?.log ?? null
}

/** Test hook. */
export function resetEventsRuntimeForTest(): void {
  cached?.runtime.stop()
  cached = null
}
