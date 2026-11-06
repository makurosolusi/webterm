import { Database } from 'bun:sqlite'
import type { Workspace, WsNode } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import { normalizeWorkspace, splitNodes, withPreservedNodes } from '../shared/workspace.schema'
import type { WorkspaceSummaryPage } from '../shared/workspace.summary'
import { workspaceLog } from './workspacesLog'
import { decodeSummaryCursor, encodeSummaryCursor, toSummary } from './db.summary'
import type { Settings } from '../shared/settings'
import { nextSettingsDocument, parseStored, registerAgentBaseResolver } from './settingsStore'
import { registerClaudeLaunchSettings, registerDefaultProfileOverride } from './claudeLauncher/claudeLauncher'
import { commandProfileOverride } from './claudeProvider/claudeProvider.store'
import { chmodSync } from 'node:fs'
import { dbPath, warnPermsNotTightened } from './config'
import { ensureAuditSchema } from './featureCapabilities.audit'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { ensureLayoutColumn, parseLayout, serializeLayout } from './db.layout'

const DB_FILE_MODE = 0o600

export function openDb(path: string = dbPath()): Database {
  const d = new Database(path)
  // Umask membuat berkas 0644; -wal/-shm/-journal mewarisi mode berkas utama. Lewati DB sementara/memori.
  if (path !== ':memory:' && path !== '' && process.platform !== 'win32') {
    try {
      chmodSync(path, DB_FILE_MODE)
    } catch (e) {
      warnPermsNotTightened(e) // volume Docker / FS read-only: jangan jatuhkan boot
    }
  }
  d.exec(`CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT, color TEXT,
    viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
    nodes TEXT NOT NULL DEFAULT '[]', bridges TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL);`)
  d.exec(`CREATE TABLE IF NOT EXISTS app (key TEXT PRIMARY KEY, value TEXT);`)
  // Back-compat: add the bridges column to workspaces created before context-link
  // bridges existed. SQLite has no ADD COLUMN IF NOT EXISTS, so guard via pragma.
  const cols = d.query('PRAGMA table_info(workspace)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'bridges')) {
    d.exec("ALTER TABLE workspace ADD COLUMN bridges TEXT NOT NULL DEFAULT '[]'")
  }
  ensureLayoutColumn(d)
  // Keyset index for the paged summary list (Db.listSummaries). IF NOT EXISTS = idempotent on
  // every boot; building it on an existing table needs no backfill.
  d.exec('CREATE INDEX IF NOT EXISTS workspace_updated_id ON workspace (updated_at DESC, id DESC)')
  ensureAuditSchema(d)
  return d
}

interface Row {
  id: string
  name: string
  cwd: string | null
  color: string | null
  viewport: string
  nodes: string
  bridges: string
  layout: string
  updated_at: number
}

/** Column text -> value; unparsable -> `null`, which the schema then reports and replaces. */
function parseColumn(raw: string | null | undefined, absent: string): unknown {
  try {
    return JSON.parse(raw ?? absent)
  } catch {
    return null // a truncated/hand-edited blob: normalizeWorkspace turns it into a default + an issue
  }
}

/**
 * Row -> workspace through the shared schema, so one bad blob or node degrades THAT board (hidden
 * node, default viewport, warning with the id) instead of throwing out of `list()` for every board.
 * A hidden node with an id stays in the row: `Db.nodesColumn` carries it through every write.
 */
function toWorkspace(r: Row): Workspace {
  const { board, issues, preserved } = normalizeWorkspace({
    name: r.name, cwd: r.cwd, color: r.color,
    viewport: parseColumn(r.viewport, ''), nodes: parseColumn(r.nodes, ''), bridges: parseColumn(r.bridges, '[]'),
  })
  if (issues.length > 0) workspaceLog.repaired(r.id, issues)
  if (preserved.length > 0) workspaceLog.nodesPreserved(r.id, preserved)
  return { id: r.id, ...board, name: r.name, layout: parseLayout(r.layout), updatedAt: r.updated_at }
}

/** Result of `Db.save`: written, refused because the stored board is newer, or no such row. */
export type SaveOutcome = 'saved' | 'stale' | 'missing'

export class Db {
  constructor(private d: Database) {}

  list(): Workspace[] {
    const rows = this.d.query('SELECT * FROM workspace ORDER BY updated_at DESC').all() as Row[]
    return rows.map(toWorkspace)
  }

  /**
   * One page of the sidebar view, newest first. Keyset order (`updated_at DESC, id DESC`, both in
   * the cursor) is stable while rows are saved between pages: no skipped or repeated rows from
   * OFFSET drift. `limit` is clamped by the caller (route).
   */
  listSummaries(limit: number, cursor?: string): WorkspaceSummaryPage {
    const after = cursor ? decodeSummaryCursor(cursor) : null
    const rows = (after
      ? this.d.query('SELECT * FROM workspace WHERE updated_at < ?1 OR (updated_at = ?1 AND id < ?2) ORDER BY updated_at DESC, id DESC LIMIT ?3').all(after.updatedAt, after.id, limit + 1)
      : this.d.query('SELECT * FROM workspace ORDER BY updated_at DESC, id DESC LIMIT ?1').all(limit + 1)) as Row[]
    const items = rows.slice(0, limit).map((r) => toSummary(toWorkspace(r)))
    const last = items[items.length - 1]
    return rows.length > limit && last ? { items, nextCursor: encodeSummaryCursor(last) } : { items }
  }

  /**
   * Every node id the stored rows hold, readable or preserved (raw column, not the served board), so
   * the orphan reaper never ends the session of a node this build merely cannot display.
   */
  nodeIds(): string[] {
    const rows = this.d.query('SELECT nodes FROM workspace').all() as Pick<Row, 'nodes'>[]
    return rows.flatMap((r) => {
      const { nodes, preserved } = splitNodes(parseColumn(r.nodes, '[]'))
      return [...nodes, ...preserved].map((n) => n.id)
    })
  }

  get(id: string): Workspace | null {
    const row = this.d.query('SELECT * FROM workspace WHERE id = ?').get(id) as Row | null
    return row ? toWorkspace(row) : null
  }

  create(name: string, cwd?: string, color?: string): Workspace {
    const ws: Workspace = {
      id: crypto.randomUUID(),
      name,
      cwd,
      color,
      viewport: DEFAULT_VIEWPORT,
      nodes: [],
      bridges: [],
      layout: defaultTabLayout(),
      updatedAt: Date.now(),
    }
    this.d.query(
      'INSERT INTO workspace (id, name, cwd, color, viewport, nodes, bridges, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(ws.id, ws.name, ws.cwd ?? null, ws.color ?? null, JSON.stringify(ws.viewport), this.nodesColumn(ws.id, ws.nodes), JSON.stringify(ws.bridges), ws.updatedAt)
    return ws
  }

  /**
   * The value of the `nodes` column for a write of `incoming` to row `id`: the stored row's preserved
   * (unreadable) nodes ride along unless `incoming` reuses their id. EVERY write of the column goes
   * through here (db.preserveNodes policy test); the caller holds the write transaction, so the
   * stored nodes read here are the ones the write replaces.
   */
  private nodesColumn(id: string, incoming: readonly WsNode[]): string {
    const row = this.d.query('SELECT nodes FROM workspace WHERE id = ?').get(id) as Pick<Row, 'nodes'> | null
    return JSON.stringify(withPreservedNodes(incoming, row ? parseColumn(row.nodes, '[]') : []))
  }

  /** BEGIN IMMEDIATE: the write lock is taken before `fn` reads, so no other connection writes in between. */
  private immediate<T>(fn: () => T): T {
    this.d.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.d.exec('COMMIT')
      return result
    } catch (err) {
      this.d.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Update an EXISTING board; never creates one (creation is `create`), so a save that lands after
   * a delete cannot resurrect the row. `base` = the `updatedAt` the writer last saw: when the
   * stored row is newer the write is refused ('stale') instead of replacing another window's board.
   * Check and write are one statement, so two racing writers cannot both pass. `updated_at` is
   * strictly increasing per row (MAX with +1): two saves in the same millisecond still differ.
   * `base` absent = unconditional (server-side writers such as templates). Stored preserved nodes
   * are carried through (`nodesColumn`), in the same transaction as the write.
   */
  save(ws: Workspace, base?: number): SaveOutcome {
    return this.immediate(() => {
      const r = this.d.query(
        `UPDATE workspace SET name=?1, cwd=?2, color=?3, viewport=?4, nodes=?5, bridges=?6,
           layout=COALESCE(NULLIF(?7, ''), layout), updated_at=MAX(?8, updated_at + 1)
         WHERE id=?9 AND (?10 IS NULL OR updated_at <= ?10)`
      ).run(ws.name, ws.cwd ?? null, ws.color ?? null, JSON.stringify(ws.viewport), this.nodesColumn(ws.id, ws.nodes), JSON.stringify(ws.bridges), serializeLayout(ws.layout), Date.now(), ws.id, base ?? null)
      if (r.changes > 0) return 'saved'
      return this.d.query('SELECT 1 FROM workspace WHERE id = ?').get(ws.id) ? 'stale' : 'missing'
    })
  }

  delete(id: string): void {
    this.d.query('DELETE FROM workspace WHERE id = ?').run(id)
  }

  getActive(): string | null {
    const row = this.d.query("SELECT value FROM app WHERE key = 'active'").get() as { value: string } | null
    return row ? row.value : null
  }

  setActive(id: string): void {
    this.d.query(
      "INSERT INTO app (key, value) VALUES ('active', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(id)
  }

  /** Settings hidup sebagai SATU baris JSON di tabel `app` yang sudah ada (kunci `'settings'`),
   *  jadi mengangkatnya ke persistensi butuh nol migrasi skema. */
  getSettings(): Settings {
    const row = this.d.query("SELECT value FROM app WHERE key = 'settings'").get() as { value: string } | null
    return parseStored(row ? row.value : null)
  }

  /** Patch the RAW stored document (`nextSettingsDocument`), write it, return the normalized view. Sinkron dari ujung
   *  ke ujung — lihat catatan di `settingsStore.ts` soal kenapa tidak ada rantai tulis. */
  saveSettings(patch: unknown): Settings {
    const row = this.d.query("SELECT value FROM app WHERE key = 'settings'").get() as { value: string } | null
    const next = nextSettingsDocument(row ? row.value : null, patch)
    this.d.query(
      "INSERT INTO app (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(JSON.stringify(next.doc))
    return next.settings
  }

  /** Shutdown only (index.ts exit hook): later calls on this store throw. Cast like ledgerRuntime.ts: the local bun:sqlite type omits close. */
  close(): void { (this.d as unknown as { close(): void }).close() }
}

export const db = new Db(openDb())

// Agent custom mewarisi kapabilitas harness lewat `baseAgent`; resolvernya harus didaftarkan
// sekali per runtime (lihat `shared/workspace.ts`). Di sini, bukan di entry server, karena ini
// satu-satunya modul yang memegang store settings sisi server.
registerAgentBaseResolver(() => db.getSettings())
registerClaudeLaunchSettings(() => db.getSettings())
registerDefaultProfileOverride(() => commandProfileOverride()) // Claude provider command mode picks the default launch profile
