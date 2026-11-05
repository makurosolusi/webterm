import { Database } from 'bun:sqlite'
import type { Workspace, WsNode, Viewport, BridgeLink } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import { nextSettings, parseStored, registerAgentBaseResolver } from './settingsStore'
import { registerClaudeLaunchSettings } from './claudeLauncher/claudeLauncher'
import { chmodSync } from 'node:fs'
import { dbPath, warnPermsNotTightened } from './config'
import { ensureAuditSchema } from './featureCapabilities.audit'

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
    updatedAt: r.updated_at,
  }
}

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
      updatedAt: Date.now(),
    }
    this.d.query(
      'INSERT INTO workspace (id, name, cwd, color, viewport, nodes, bridges, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(ws.id, ws.name, ws.cwd ?? null, ws.color ?? null, JSON.stringify(ws.viewport), JSON.stringify(ws.nodes), JSON.stringify(ws.bridges), ws.updatedAt)
    return ws
  }

  save(ws: Workspace): void {
    const updatedAt = Date.now()
    this.d.query(
      `INSERT INTO workspace (id, name, cwd, color, viewport, nodes, bridges, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, cwd=excluded.cwd, color=excluded.color,
         viewport=excluded.viewport, nodes=excluded.nodes, bridges=excluded.bridges,
         updated_at=excluded.updated_at`
    ).run(ws.id, ws.name, ws.cwd ?? null, ws.color ?? null, JSON.stringify(ws.viewport), JSON.stringify(ws.nodes), JSON.stringify(ws.bridges), updatedAt)
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
}

export const db = new Db(openDb())

// Agent custom mewarisi kapabilitas harness lewat `baseAgent`; resolvernya harus didaftarkan
// sekali per runtime (lihat `shared/workspace.ts`). Di sini, bukan di entry server, karena ini
// satu-satunya modul yang memegang store settings sisi server.
registerAgentBaseResolver(() => db.getSettings())
registerClaudeLaunchSettings(() => db.getSettings())
