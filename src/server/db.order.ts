import type { Database } from 'bun:sqlite'
import type { WorkspaceOrderReason } from '../shared/workspace.order'

/**
 * The persisted workspace order lives in its OWN table (`workspace_position`), not a column of
 * `workspace`: a reorder is then one statement that never rewrites a board row, never moves
 * `updated_at` (so it cannot turn another window's unsent save into a 409) and stays outside the
 * "every `workspace` write carries `nodes` through `nodesColumn`" policy, which only a board write
 * can satisfy. Before this table the order was `updated_at DESC`, which shifted on every edit.
 *
 * Step marker = table existence; the backfill inserts only workspaces without a position, so both
 * steps are idempotent and a crash between them is repaired by the next boot.
 */
export function ensureOrderTable(d: Database): void {
  d.exec('CREATE TABLE IF NOT EXISTS workspace_position (workspace_id TEXT PRIMARY KEY, position INTEGER NOT NULL)')
  d.exec('CREATE INDEX IF NOT EXISTS workspace_position_pos ON workspace_position (position)')
}

/**
 * Give every workspace without a position one after the existing ones, in the order users saw until
 * now (`updated_at DESC, id DESC`), so an upgrade does not reshuffle anyone's tabs. Also drops rows of
 * workspaces that no longer exist. Returns how many workspaces were backfilled (0 on a second run).
 */
export function backfillOrder(d: Database): number {
  d.exec('BEGIN IMMEDIATE')
  try {
    d.exec('DELETE FROM workspace_position WHERE workspace_id NOT IN (SELECT id FROM workspace)')
    const top = d.query('SELECT COALESCE(MAX(position), -1) AS top FROM workspace_position').get() as { top: number }
    const r = d.query(
      `INSERT INTO workspace_position (workspace_id, position)
       SELECT id, ?1 + ROW_NUMBER() OVER (ORDER BY updated_at DESC, id DESC) FROM workspace
       WHERE id NOT IN (SELECT workspace_id FROM workspace_position)`
    ).run(top.top)
    d.exec('COMMIT')
    return r.changes
  } catch (err) {
    d.exec('ROLLBACK')
    throw new Error(`workspace order backfill failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/** A new workspace goes to the end. Caller holds the write transaction. */
export function appendPosition(d: Database, id: string): void {
  d.query('INSERT INTO workspace_position (workspace_id, position) SELECT ?1, COALESCE(MAX(position), -1) + 1 FROM workspace_position').run(id)
}

/** Forget a deleted workspace and close the gap, keeping the relative order (one UPDATE, no loop). Caller holds the write transaction. */
export function dropPosition(d: Database, id: string): void {
  d.query('DELETE FROM workspace_position WHERE workspace_id = ?').run(id)
  d.exec('UPDATE workspace_position SET position = (SELECT COUNT(*) FROM workspace_position p WHERE p.position < workspace_position.position)')
}

/**
 * Replace the whole order with `ids`. `ids` must be exactly the stored workspaces, each once. Check and
 * the single batch upsert (`json_each` index = new position) run in the caller's write transaction, and
 * every refusal returns BEFORE the write, so a refusal changes nothing. Returns the reason or null.
 */
export function applyOrder(d: Database, ids: readonly string[]): WorkspaceOrderReason | null {
  if (new Set(ids).size !== ids.length) return 'duplicate'
  const stored = new Set((d.query('SELECT id FROM workspace').all() as { id: string }[]).map((r) => r.id))
  if (ids.some((id) => !stored.has(id))) return 'unknown'
  if (ids.length !== stored.size) return 'missing'
  d.query(
    `INSERT INTO workspace_position (workspace_id, position)
     SELECT value, key FROM json_each(?1) WHERE true
     ON CONFLICT(workspace_id) DO UPDATE SET position = excluded.position`
  ).run(JSON.stringify(ids))
  return null
}
