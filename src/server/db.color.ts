import type { Database } from 'bun:sqlite'

/**
 * Add `workspace.color_shade` (soft|default|vivid) for the workspace color feature. `NOT NULL DEFAULT 'default'`
 * backfills every row in place; the column check is the step marker, so running it again is a no-op.
 * The hue backfill (rows whose `color` is not a palette hue) writes the workspace table, so it lives in
 * db.ts (`Db.backfillColors`), the only module allowed to.
 */
export function ensureColorColumns(d: Database): void {
  const cols = d.query('PRAGMA table_info(workspace)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'color_shade')) d.exec("ALTER TABLE workspace ADD COLUMN color_shade TEXT NOT NULL DEFAULT 'default'")
}
