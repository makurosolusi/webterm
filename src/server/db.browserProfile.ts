import type { Database } from 'bun:sqlite'

/** Stored profile row (runtime facts like `live`/`nodeCount` are computed by the service, never stored). */
export interface ProfileRow { id: string; name: string; color: string; shade: string; createdAt: number; workspaceId: string | null }

/**
 * Create `browser_profile`. IF NOT EXISTS = a no-op on every later boot, and an existing database needs no backfill:
 * the table is new and holds only profiles created after this build (Default rows are written by the service at boot).
 * `name` is unique ignoring case (COLLATE NOCASE) so two profiles never read the same in a picker.
 */
export function ensureBrowserProfileTable(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS browser_profile (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
    color_shade TEXT NOT NULL DEFAULT 'default', created_at INTEGER NOT NULL, workspace_id TEXT)`)
}

export interface BrowserProfileStore {
  list(): ProfileRow[]
  get(id: string): ProfileRow | null
  /** Insert; false when the id or the name (any case) already exists. */
  insert(row: ProfileRow): boolean
  /** Patch name/color/shade; false when missing or the new name is taken. */
  update(id: string, patch: { name?: string; color?: string; shade?: string }): boolean
  remove(id: string): boolean
}

interface Raw { id: string; name: string; color: string; color_shade: string; created_at: number; workspace_id: string | null }
const toRow = (r: Raw): ProfileRow => ({ id: r.id, name: r.name, color: r.color, shade: r.color_shade, createdAt: r.created_at, workspaceId: r.workspace_id })

/** Profile registry over the app database (own table: never touches `workspace`). */
export function createBrowserProfileStore(d: Database): BrowserProfileStore {
  ensureBrowserProfileTable(d)
  const get = (id: string): ProfileRow | null => {
    const r = d.query('SELECT * FROM browser_profile WHERE id = ?').get(id) as Raw | null
    return r ? toRow(r) : null
  }
  return {
    list: () => (d.query('SELECT * FROM browser_profile ORDER BY created_at, id').all() as Raw[]).map(toRow),
    get,
    insert(row) {
      const r = d.query('INSERT OR IGNORE INTO browser_profile (id, name, color, color_shade, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.name, row.color, row.shade, row.createdAt, row.workspaceId)
      return r.changes === 1
    },
    update(id, patch) {
      const cur = get(id)
      if (!cur) return false
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
      const r = d.query('UPDATE OR IGNORE browser_profile SET name = ?, color = ?, color_shade = ? WHERE id = ?').run(next.name, next.color, next.shade, id)
      return r.changes === 1
    },
    remove: (id) => d.query('DELETE FROM browser_profile WHERE id = ?').run(id).changes === 1,
  }
}

/** Same contract over a Map: the fallback when no database is injected (tests, node-env), so nothing opens a real file. */
export function createMemoryProfileStore(): BrowserProfileStore {
  const rows = new Map<string, ProfileRow>()
  const taken = (name: string, except?: string): boolean => [...rows.values()].some((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase())
  return {
    list: () => [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    get: (id) => rows.get(id) ?? null,
    insert(row) {
      if (rows.has(row.id) || taken(row.name)) return false
      rows.set(row.id, row)
      return true
    },
    update(id, patch) {
      const cur = rows.get(id)
      if (!cur || (patch.name !== undefined && taken(patch.name, id))) return false
      rows.set(id, { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
      return true
    },
    remove: (id) => rows.delete(id),
  }
}
