// Shutdown step for the SQLite stores: closed in a fixed order on the process `exit` hook, which every
// exit path (SIGINT/SIGTERM, a crash exit, a normal exit) passes exactly once. Closing checkpoints the
// ledger's WAL into ledger.db instead of leaving recovery to the next boot. installShutdown wires that hook
// and the in-process stop for server.main.ts.
import type { Server } from 'node:http'
import { flushLogsSync, type Logger } from './logs'
import { removeInstanceFile } from './instanceFile'
import { onUncaughtExceptionMonitor, onUnhandledRejection } from './processCrash'
import { activeBrowser } from './browser/browser.activate'
import { activeAgentChatPool } from './agentChat/agentChat.pool'

export type StoreCloser = readonly [name: string, close: () => void]

/** Close each store in order; one failing close is logged with its name and never skips the next. */
export function closeStores(stores: readonly StoreCloser[], log: Pick<Logger, 'info' | 'error'>): void {
  for (const [name, close] of stores) {
    try {
      close()
      log.info('server.store.closed', `Closed ${name}`, { store: name })
    } catch (err) {
      log.error('server.store.close_failed', `Cannot close ${name} on shutdown`, { store: name, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

const BROWSER_SHUTDOWN_CAP_MS = 5000
const SIGNAL_EXIT_CODES = [['SIGINT', 130], ['SIGTERM', 143]] as const

export type ShutdownDeps = {
  log: Logger
  runDir: string
  stores: readonly StoreCloser[]
  server: Server
  /** Every live WebSocket, terminated on an in-process stop. */
  sockets: () => Iterable<{ terminate(): void }>
  devProxy: Promise<{ close(): unknown } | null>
}

/** Chat Queries aborted (no Claude child outlives the server), Chromium + proxy closed (capped). */
function releaseRuntimes(): Promise<unknown> {
  activeAgentChatPool()?.closeAll()
  const rt = activeBrowser()
  return rt ? Promise.race([rt.shutdown(), new Promise((r) => setTimeout(r, BROWSER_SHUTDOWN_CAP_MS))]) : Promise.resolve()
}

/**
 * Installs the process hooks (crash log, unhandled rejection, exit, SIGINT/SIGTERM) and returns the
 * in-process stop (src/native, tests): release runtimes, drop every socket, close the main and proxy
 * listeners so both ports are free, then close the stores. Electrobun quits through a native exit that
 * skips the process `exit` hook, so the stores cannot wait for it. The process is expected to exit next.
 */
export function installShutdown({ log, runDir, stores, server, sockets, devProxy }: ShutdownDeps): () => Promise<void> {
  // Observe-only crash hook, flushed at once (processCrash.ts: Electrobun's native exit skips the `exit` hook).
  process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor(log, flushLogsSync))
  // Bun dies on an unhandled rejection but reports exit code 0 to the `exit` hook; log it and exit 1.
  process.on('unhandledRejection', onUnhandledRejection(log))
  let storesClosed = false
  /** Once per process (`exit` hook, or the in-process stop that may exit natively without it): drop the run-dir record, close the stores. */
  const closeStoresOnce = (code: number): void => {
    if (storesClosed) return
    storesClosed = true
    try { removeInstanceFile(runDir, process.pid) } catch (e) {
      log.warn('server.instance_file_failed', 'Cannot remove this server\'s record from the run dir', { cause: e instanceof Error ? e.message : String(e) })
    }
    closeStores(stores, log)
    log.info('server.stop', 'webterm stopping', { code })
    flushLogsSync()
  }
  process.on('exit', closeStoresOnce)
  for (const [signal, exitCode] of SIGNAL_EXIT_CODES) {
    // Chromium + proxy dimatikan bersih (batas 5 dtk) sebelum proses keluar; tanpa runtime browser = perilaku lama.
    process.on(signal, () => { void releaseRuntimes().finally(() => process.exit(exitCode)) })
  }
  return async () => {
    log.info('server.stop_requested', 'In-process host is stopping webterm')
    await releaseRuntimes()
    for (const c of sockets()) c.terminate()
    // close() first, then drop keep-alive sockets: under Bun, closeAllConnections() before close() stops the listener and close() then throws.
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(new Error('cannot close the webterm listener', { cause: err })) : resolve())))
    server.closeAllConnections()
    await Promise.all([closed, devProxy.then((p) => p?.close())])
    closeStoresOnce(0)
  }
}
