// Shutdown step for the SQLite stores: closed in a fixed order on the process `exit` hook, which every
// exit path (SIGINT/SIGTERM, a crash exit, a normal exit) passes exactly once. Closing checkpoints the
// ledger's WAL into ledger.db instead of leaving recovery to the next boot.
import type { Logger } from './logs'

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
