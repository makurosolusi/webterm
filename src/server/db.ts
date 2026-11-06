import { Database } from 'bun:sqlite'
import type { Workspace, WsNode, Viewport, BridgeLink } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import { nextSettings, parseStored, registerAgentBaseResolver } from './settingsStore'
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

function toWorkspace(r: Row): Workspace {
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd ?? undefined,
    color: r.color ?? undefined,
    viewport: JSON.parse(r.viewport) as Viewport,
    nodes: JSON.parse(r.nodes) as WsNode[],
    bridges: JSON.parse(r.bridges ?? '[]') as BridgeLink[],
    layout: parseLayout(r.layout),
    updatedAt: r.updated_at,
  }
}

/** Result of `Db.save`: written, refused because the stored board is newer, or no such row. */
export type SaveOutcome = 'saved' | 'stale' | 'missing'

export class Db {
  constructor(private d: Database) {}

  list(): Workspace[] {
    const rows = this.d.query('SELECT * FROM workspace ORDER BY updated_at DESC').all() as Row[]
    return rows.map(toWorkspace)
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
    ).run(ws.id, ws.name, ws.cwd ?? null, ws.color ?? null, JSON.stringify(ws.viewport), JSON.stringify(ws.nodes), JSON.stringify(ws.bridges), ws.updatedAt)
    return ws
  }

  /**
   * Update an EXISTING board; never creates one (creation is `create`), so a save that lands after
   * a delete cannot resurrect the row. `base` = the `updatedAt` the writer last saw: when the
   * stored row is newer the write is refused ('stale') instead of replacing another window's board.
   * Check and write are one statement, so two racing writers cannot both pass. `updated_at` is
   * strictly increasing per row (MAX with +1): two saves in the same millisecond still differ.
   * `base` absent = unconditional (server-side writers such as templates).
   */
  save(ws: Workspace, base?: number): SaveOutcome {
    const r = this.d.query(
      `UPDATE workspace SET name=?1, cwd=?2, color=?3, viewport=?4, nodes=?5, bridges=?6,
         layout=COALESCE(NULLIF(?7, ''), layout), updated_at=MAX(?8, updated_at + 1)
       WHERE id=?9 AND (?10 IS NULL OR updated_at <= ?10)`
    ).run(ws.name, ws.cwd ?? null, ws.color ?? null, JSON.stringify(ws.viewport), JSON.stringify(ws.nodes), JSON.stringify(ws.bridges), serializeLayout(ws.layout), Date.now(), ws.id, base ?? null)
    if (r.changes > 0) return 'saved'
    return this.d.query('SELECT 1 FROM workspace WHERE id = ?').get(ws.id) ? 'stale' : 'missing'
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

  /** Merge `patch` di atas yang tersimpan, tulis, kembalikan snapshot hasilnya. Sinkron dari ujung
   *  ke ujung — lihat catatan di `settingsStore.ts` soal kenapa tidak ada rantai tulis. */
  saveSettings(patch: unknown): Settings {
    const row = this.d.query("SELECT value FROM app WHERE key = 'settings'").get() as { value: string } | null
    const next = nextSettings(row ? row.value : null, patch)
    this.d.query(
      "INSERT INTO app (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(JSON.stringify(next))
    return next
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
