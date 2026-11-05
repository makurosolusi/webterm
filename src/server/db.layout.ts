import type { Database } from 'bun:sqlite'
import { defaultTabLayout, normalizeTabLayout, type TabLayout } from '../shared/tabLayout.schema'

/**
 * Add `workspace.layout` (tab-mode view, JSON) to databases created before tab mode. SQLite has no
 * ADD COLUMN IF NOT EXISTS, so guard via pragma: running it any number of times is a no-op after
 * the first. The workspace table has no version counter (the "v22" migrations belong to
 * ledger.db), so the column check IS the step marker, same as the `bridges` column in db.ts.
 *
 * NOT NULL DEFAULT '' backfills every existing row without rewriting it; '' means "never set" and
 * reads back as the canvas default, so existing boards open exactly as before.
 */
export function ensureLayoutColumn(d: Database): void {
  const cols = d.query('PRAGMA table_info(workspace)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'layout')) d.exec("ALTER TABLE workspace ADD COLUMN layout TEXT NOT NULL DEFAULT ''")
}

/** Column text -> layout. '' / malformed JSON -> canvas default (a bad blob must not break boot). */
export function parseLayout(raw: string | null | undefined): TabLayout {
  if (!raw) return defaultTabLayout()
  try {
    return normalizeTabLayout(JSON.parse(raw))
  } catch {
    return defaultTabLayout()
  }
}

/** Layout -> column text; '' when absent so the upsert keeps the stored layout (see Db.save). */
export const serializeLayout = (layout: TabLayout | undefined): string =>
  layout === undefined ? '' : JSON.stringify(normalizeTabLayout(layout))
