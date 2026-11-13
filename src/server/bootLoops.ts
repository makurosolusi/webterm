// Background loops that must run without the UI open, split from server.main.ts (which starts the
// server on import). A loop that cannot start is logged; boot goes on. Central and device loops never
// run under a test runner.
import { basename } from 'node:path'
import { createLogger, type Logger } from './logs'
import { startLedgerReaper, type LedgerRuntime } from './ledger/ledgerRuntime'
import { createTrashReaper } from './fsBoot'
import { flushBootChanges } from './bootChanges'
import { announceRetentionSweep } from './central/retentionNotice'
import { db } from './db'
import { bootCentralNotices } from './central/centralNotices'
import { ensureRoutines } from './routines/routinesRuntime'
import { startCostCapture } from './cost/costRuntime'
import { armDagLoop } from './dag/dag.runtime'
import { pruneCanvasBackgrounds } from './canvasBackground.gc'
import { backgroundsDir } from './canvasBackground.store'
import { startPortScanner } from './ports/ports.runtime'
import { startWebPush } from './push/push.runtime'

type BootLog = Pick<Logger, 'warn'>

const cause = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const underTest = (): boolean => process.env.NODE_ENV === 'test'

/** Before the capability reconcile: Central notices, routines, cost capture, the DAG loop, wallpaper GC. */
export function startCentralLoops(log: BootLog): void {
  if (underTest()) return
  // Central is the notification hub with or without Telegram: gate and agent notices land in its chat.
  bootCentralNotices()
  // Schedules and event triggers must fire without the UI open (otherwise the first /api/routines call starts them).
  try { ensureRoutines() } catch (e) { log.warn('routines.start.failed', 'Cannot start routines at boot', { cause: cause(e) }) }
  // Cost capture listens to agent hooks from the first session; a DAG left active by a restart resumes polling.
  startCostCapture().catch((e: unknown) => log.warn('cost.start.failed', 'Cannot start cost capture at boot', { cause: cause(e) }))
  try { armDagLoop() } catch (e) { log.warn('dag.start.failed', 'Cannot arm the DAG scheduler at boot', { cause: cause(e) }) }
  // Wallpaper GC: overrides of deleted workspaces + image files nothing references (one readdir).
  pruneCanvasBackgrounds(db, new Set(db.list().map((w) => w.id)), backgroundsDir()).catch((e: unknown) => log.warn('canvas-background.prune_failed', 'Cannot prune canvas backgrounds at boot', { cause: cause(e) }))
}

/** After the capability reconcile: the port scanner and Web Push. */
export function startDeviceLoops(log: BootLog): void {
  if (underTest()) return
  // Port events must exist without the UI open (otherwise the first GET /api/ports starts it).
  startPortScanner().catch((e: unknown) => log.warn('ports.start.failed', 'Cannot start port scanner at boot', { cause: cause(e) }))
  // Web Push to the /m PWA: a gate must reach a phone that is asleep, so the loop runs without /m open.
  startWebPush().catch((e: unknown) => log.warn('push.start.failed', 'Cannot start web push at boot', { cause: cause(e) }))
}

/** Ledger open: log its mode, start the retention reaper, post the startup changes notice (bootChanges.ts). */
export function startLedgerLoops(rt: LedgerRuntime, log: BootLog): void {
  createLogger('ledger').info('ledger.start', `Ledger ${rt.mode}`, { mode: rt.mode, file: basename(rt.path) })
  startLedgerReaper({ task: rt.ledger.task, retention: rt.ledger.retention, trash: createTrashReaper(), onRetention: (changed) => announceRetentionSweep(changed) })
  try { flushBootChanges(rt.db) } catch (e) { log.warn('boot.changes_notice_failed', 'Cannot post the startup changes notice', { cause: cause(e) }) }
}
