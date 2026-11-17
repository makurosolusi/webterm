import type { Database } from 'bun:sqlite'
import { backfillWorkspaceHue, isWorkspaceHue } from '../shared/workspaceColor'

/**
 * Give every workspace a palette color (`color` = hue id, `color_shade` = soft|default|vivid).
 * `workspace.color` already existed as free text that nothing in the UI wrote, so it is reused
 * instead of adding a second column; rows whose value is not a palette hue (NULL or legacy text)
 * get a hue derived from their id, so the same board keeps the same color on every boot rather
 * than a new random one each load. The shade column is `NOT NULL DEFAULT 'default'` (backfills in
 * place, no rewrite). Idempotent: after the first run nothing matches the backfill query.
 */
export function ensureColorColumns(d: Database): void {
  const cols = d.query('PRAGMA table_info(workspace)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'color_shade')) d.exec("ALTER TABLE workspace ADD COLUMN color_shade TEXT NOT NULL DEFAULT 'default'")
  const rows = d.query('SELECT id, color FROM workspace').all() as { id: string; color: string | null }[]
  const update = d.query('UPDATE workspace SET color = ?1 WHERE id = ?2')
  for (const r of rows) if (!isWorkspaceHue(r.color)) update.run(backfillWorkspaceHue(r.id), r.id)
}
