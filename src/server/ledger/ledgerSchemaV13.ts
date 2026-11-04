/**
 * v13 `channel_store` (PLAN/02-fase.md F2-g): the Telegram channel store (bindings, reply outbox,
 * update dedupe) moves from `<dataDir>/channels/channels.json` into the ledger. One row holds the
 * same strictly-validated JSON document the file held, so `channelStoreSchema.ts` stays the single
 * shape check and an import is a byte-for-byte copy.
 *
 * - `id = 1` CHECK: exactly one document; an upsert replaces it atomically inside SQLite.
 * - `imported_from`: legacy file the row was imported from (null for a fresh store); the import
 *   itself runs once in `channels/channelStoreLedger.ts` (absent row = not yet imported).
 * - No secrets: tokens never lived in channels.json either.
 *
 * Additive only (CREATE ... IF NOT EXISTS): a re-run after a partial apply is safe, no existing
 * table changes, and there is nothing to backfill (the import is lazy, at channel start).
 */
import type { Database } from 'bun:sqlite'

export const DDL_V13 = `
CREATE TABLE IF NOT EXISTS channel_store (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  doc           TEXT NOT NULL,
  imported_from TEXT,
  updated_at    INTEGER NOT NULL
);
`

export function applyV13(db: Database): void {
  db.exec(DDL_V13)
}
