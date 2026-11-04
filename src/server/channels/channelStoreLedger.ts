// Ledger backend for the channel store (F2-g): the document lives in the v13 `channel_store` row.
// One-time import: while the row is absent, the legacy `channels.json` (if any) is read and handed
// to the store, which validates it (fail closed: a corrupt file is never imported) and writes it
// back through `write`. That first write inserts the row and then renames the file to
// `channels.json.imported.bak`. From then on only the row is read or written; a leftover file is
// ignored because the row's presence is the "already imported" marker.
import type { Database } from 'bun:sqlite'
import { existsSync, renameSync } from 'node:fs'
import { execWrite, getRow } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { PersistError, readStoreFile, type ChannelStorePersistence } from './channelStorePersist'

export const STORE_IMPORT_BACKUP_SUFFIX = '.imported.bak'
const log = createLogger('channels')

/** `legacyPath`: the pre-ledger `channels.json`; read at most once, then renamed to the backup. */
export function ledgerPersistence(db: Database, legacyPath: string, now: () => number = Date.now): ChannelStorePersistence {
  let pendingImport = false
  return {
    location: 'ledger:channel_store',
    get pendingImport() {
      return pendingImport
    },
    read() {
      let row: Record<string, unknown> | null
      try {
        row = getRow(db, 'SELECT doc FROM channel_store WHERE id = 1')
      } catch {
        throw new PersistError('read_failed')
      }
      if (row) return String(row['doc'])
      const legacy = readStoreFile(legacyPath)
      pendingImport = legacy !== null
      return legacy
    },
    write(doc) {
      try {
        execWrite(
          db,
          `INSERT INTO channel_store (id, doc, imported_from, updated_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
          doc,
          pendingImport ? legacyPath : null,
          now()
        )
      } catch {
        throw new PersistError('write_failed')
      }
      if (!pendingImport) return
      pendingImport = false
      const backup = `${legacyPath}${STORE_IMPORT_BACKUP_SUFFIX}`
      try {
        // An older backup is never overwritten; the row is the truth either way.
        if (!existsSync(backup)) renameSync(legacyPath, backup)
        log.info('channels.store_imported', 'channels.json imported into the ledger', { backup: existsSync(backup) })
      } catch (err) {
        log.warn('channels.store_import_backup_failed', 'channels.json imported, but renaming it to the backup failed', {
          error: err instanceof Error ? err.name : typeof err,
        })
      }
    },
    // The import backup holds the original v1 bytes; nothing else to keep.
    backupV1() {},
  }
}
