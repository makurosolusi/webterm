// Penyimpanan SQLite untuk panel Agent History: indeks transcript agent (`agent_session`) dan
// riwayat node yang ditutup (`closed_history`). Bentuk `HistoryDb` struktural (pola
// `featureCapabilities.audit.ts`) supaya modul ini tidak mengimpor bun:sqlite saat dimuat.
import type { BridgeLink, WsNode } from '../shared/workspace'
import { newParseState, type HistoryAgent, type SessionParseState } from './sessionHistory.parse'

/** Bagian `bun:sqlite` Database yang dipakai modul ini. */
export interface HistoryDb {
  exec(sql: string): unknown
  query(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
}

/** Migrasi idempoten (Rule 4): dua tabel baru, tanpa menyentuh tabel lama, jadi aman dijalankan
 *  di tiap boot di atas webterm.db yang sudah berisi data. */
export function ensureSessionHistorySchema(db: HistoryDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_session (
    path TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    id TEXT NOT NULL,
    cwd TEXT,
    title TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    message_count INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    parsed_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS agent_session_cwd ON agent_session(cwd);
  CREATE INDEX IF NOT EXISTS agent_session_recent ON agent_session(ended_at);
  -- "Recently closed" dulu hanya di memori dan lenyap tiap reload; satu baris per node sesi yang
  -- ditutup, snapshot WsNode utuh di kolom node (JSON) karena node itu tak ada di tempat lain lagi.
  CREATE TABLE IF NOT EXISTS closed_history (
    node_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    closed_at INTEGER NOT NULL,
    node TEXT NOT NULL
  );
  -- Nodes CENTRAL closed (canvas.close), kept apart from closed_history because the client rewrites that whole
  -- list on every change and so cannot carry "who closed it". canvas.reopen reads only this table: a node the
  -- human closed is never in it. Additive and idempotent; bounded by the store's per-workspace cap.
  CREATE TABLE IF NOT EXISTS central_closed (
    node_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    closed_at INTEGER NOT NULL,
    node TEXT NOT NULL,
    bridges TEXT
  );`)
  // F3-d: the closed node's cables, so reopening after a reload brings its edges back. Nullable
  // (rows written before this column have none). SQLite has no ADD COLUMN IF NOT EXISTS, hence the
  // table_info check that keeps this idempotent on every boot.
  const cols = db.query('PRAGMA table_info(closed_history)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'bridges')) db.exec('ALTER TABLE closed_history ADD COLUMN bridges TEXT')
}

/** Baris indeks yang tersimpan: state parse + sidik file untuk scan inkremental. */
export interface IndexedFile extends SessionParseState {
  path: string
  mtimeMs: number
  size: number
  parsedBytes: number
}

interface FileRow {
  path: string; agent: HistoryAgent; id: string; cwd: string | null; title: string | null
  started_at: number | null; ended_at: number | null; message_count: number
  mtime_ms: number; size: number; parsed_bytes: number
}

const toIndexed = (r: FileRow): IndexedFile => ({
  ...newParseState(r.agent, r.id),
  cwd: r.cwd, title: r.title, startedAt: r.started_at, endedAt: r.ended_at, messageCount: r.message_count,
  path: r.path, mtimeMs: r.mtime_ms, size: r.size, parsedBytes: r.parsed_bytes,
})

export function getIndexed(db: HistoryDb, path: string): IndexedFile | null {
  const r = db.query('SELECT * FROM agent_session WHERE path = ?').get(path) as FileRow | null
  return r ? toIndexed(r) : null
}

export function putIndexed(db: HistoryDb, f: IndexedFile): void {
  db.query(`INSERT INTO agent_session (path, agent, id, cwd, title, started_at, ended_at, message_count, mtime_ms, size, parsed_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET agent=excluded.agent, id=excluded.id, cwd=excluded.cwd, title=excluded.title,
      started_at=excluded.started_at, ended_at=excluded.ended_at, message_count=excluded.message_count,
      mtime_ms=excluded.mtime_ms, size=excluded.size, parsed_bytes=excluded.parsed_bytes`)
    .run(f.path, f.agent, f.id, f.cwd, f.title, f.startedAt, f.endedAt, f.messageCount, f.mtimeMs, f.size, f.parsedBytes)
}

/** Buang baris `agents` untuk file yang sudah tidak ada di disk (dihapus CLI / pembersihan 30 hari).
 *  Baris agent lain (mis. `codex` dari sebelum Claude-first) tidak disentuh. */
export function pruneIndexed(db: HistoryDb, present: ReadonlySet<string>, agents: ReadonlySet<string>): void {
  const rows = db.query('SELECT path, agent FROM agent_session').all() as { path: string; agent: string }[]
  for (const { path, agent } of rows) {
    if (agents.has(agent) && !present.has(path)) db.query('DELETE FROM agent_session WHERE path = ?').run(path)
  }
}

/** Satu sesi di respons API. `path` sengaja tidak ikut: klien tidak butuh lokasi file. */
export interface SessionSummary {
  agent: HistoryAgent
  id: string
  cwd: string | null
  title: string | null
  startedAt: number | null
  endedAt: number | null
  messageCount: number
}

export interface SessionPage {
  items: SessionSummary[]
  total: number
  /** Offset halaman berikutnya, `null` bila ini halaman terakhir. */
  nextOffset: number | null
}

export const PAGE_DEFAULT = 30
export const PAGE_MAX = 100

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Halaman sesi terbaru dulu. `cwd` = workspace: sesi di cwd itu ATAU subdirektorinya. Sesi tanpa
 *  pesan disembunyikan (Orca "Hide empty sessions"): tidak ada yang bisa dilanjutkan di sana.
 *  Claude sessions only: indexed `codex` rows from before Claude-first stay in the DB but are hidden. */
export function listSessions(
  db: HistoryDb,
  opts: { cwd?: string; q?: string; limit?: number; offset?: number },
): SessionPage {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX)
  const offset = Math.max(Math.trunc(opts.offset ?? 0) || 0, 0)
  const where = ["agent = 'claude'", 'message_count > 0']
  const params: unknown[] = []
  const cwd = opts.cwd?.replace(/\/+$/, '')
  if (cwd) {
    const prefix = `${cwd}/`
    where.push('(cwd = ? OR substr(cwd, 1, ?) = ?)')
    params.push(cwd, prefix.length, prefix)
  }
  const q = opts.q?.trim()
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')")
    const pat = `%${likeEscape(q)}%`
    params.push(pat, pat)
  }
  const sql = `FROM agent_session WHERE ${where.join(' AND ')}`
  const total = (db.query(`SELECT COUNT(*) AS n ${sql}`).get(...params) as { n: number }).n
  const rows = db
    .query(`SELECT * ${sql} ORDER BY COALESCE(ended_at, mtime_ms) DESC, path LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as FileRow[]
  const items = rows.map((r) => ({
    agent: r.agent, id: r.id, cwd: r.cwd, title: r.title,
    startedAt: r.started_at, endedAt: r.ended_at, messageCount: r.message_count,
  }))
  return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null }
}

// ---------------------------------------------------------------------------------------------
// Closed history.

/** Sama dengan `ClosedEntry` di client (`src/client/closedHistory.ts`). */
export interface ClosedRecord {
  node: WsNode
  workspaceId: string
  workspaceName: string
  closedAt: number
  /** Cables that touched the node when it was closed; absent on old rows. */
  bridges?: BridgeLink[]
}

/** Batas server = `CLOSED_HISTORY_CAP` client; dijaga di sini juga supaya klien lain tak bisa
 *  membengkakkan tabel. */
export const CLOSED_CAP = 10

export function listClosed(db: HistoryDb): ClosedRecord[] {
  const rows = db.query('SELECT * FROM closed_history ORDER BY closed_at DESC LIMIT ?').all(CLOSED_CAP) as {
    workspace_id: string; workspace_name: string; closed_at: number; node: string; bridges: string | null
  }[]
  return rows.map((r) => ({
    node: JSON.parse(r.node) as WsNode,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    closedAt: r.closed_at,
    ...(r.bridges ? { bridges: JSON.parse(r.bridges) as BridgeLink[] } : {}),
  }))
}

/** Ganti seluruh daftar (≤ CLOSED_CAP baris) dalam satu transaksi: klien selalu mengirim daftar
 *  utuh, jadi tidak ada urutan push/hapus yang bisa saling balap di server. */
export function replaceClosed(db: HistoryDb, list: readonly ClosedRecord[]): void {
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM closed_history')
    const ins = db.query('INSERT OR REPLACE INTO closed_history (node_id, workspace_id, workspace_name, closed_at, node, bridges) VALUES (?, ?, ?, ?, ?, ?)')
    for (const e of list.slice(0, CLOSED_CAP)) {
      const bridges = e.bridges?.length ? JSON.stringify(e.bridges) : null
      ins.run(e.node.id, e.workspaceId, e.workspaceName, e.closedAt, JSON.stringify(e.node), bridges)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw new Error(`replace closed_history (${list.length} entries) failed: ${(e as Error).message}`)
  }
}
