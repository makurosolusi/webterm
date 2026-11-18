import { Database } from 'bun:sqlite'
import type { Workspace, WsNode } from '../shared/workspace'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import { lockNodePresets } from './workspace.presets'
import { splitNodes, withPreservedNodes } from '../shared/workspace.schema'
import { withNodeNames } from '../shared/nodeNames'
import type { WorkspaceSummaryPage } from '../shared/workspace.summary'
import { decodeSummaryCursor, encodeSummaryCursor, toSummary } from './db.summary'
import type { Settings } from '../shared/settings'
import { nextSettingsDocument, parseStored, registerAgentBaseResolver } from './settingsStore'
import { registerClaudeLaunchSettings, registerDefaultProfileOverride } from './claudeLauncher/claudeLauncher'
import { registerModelSettings } from './models/modelOverride'
import { commandProfileOverride } from './claudeProvider/claudeProvider.store'
import { chmodSync } from 'node:fs'
import { dbPath, warnPermsNotTightened } from './config'
import { ensureAuditSchema } from './featureCapabilities.audit'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { ensureLayoutColumn, serializeLayout } from './db.layout'
import { ensureColorColumns } from './db.color'
import { parseColumn, toWorkspace, SELECT_WS, ORDER_WS } from './db.row'
import type { Row } from './db.row'
import { appendPosition, applyOrder, backfillOrder, dropPosition, ensureOrderTable } from './db.order'
import type { WorkspaceOrderReason } from '../shared/workspace.order'
import { createBrowserProfileStore, ensureBrowserProfileTable } from './db.browserProfile'
import type { BrowserProfileStore } from './db.browserProfile'
import { pickWorkspaceColor, DEFAULT_WORKSPACE_SHADE, describeWorkspaceColor, isWorkspaceHue, backfillWorkspaceHue } from '../shared/workspaceColor'
import type { WorkspaceHue, WorkspaceShade } from '../shared/workspaceColor'

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
  ensureColorColumns(d)
  ensureOrderTable(d) // before backfillColors: every `Db.get` joins it
  new Db(d).backfillColors()
  backfillOrder(d)
  // Keyset index for the paged summary list (Db.listSummaries). IF NOT EXISTS = idempotent on
  // every boot; building it on an existing table needs no backfill.
  d.exec('CREATE INDEX IF NOT EXISTS workspace_updated_id ON workspace (updated_at DESC, id DESC)')
  ensureAuditSchema(d)
  ensureBrowserProfileTable(d)
  return d
}

/** Result of `Db.save`: written, refused because the stored board is newer, or no such row. */
export type SaveOutcome = 'saved' | 'stale' | 'missing'

export class Db {
  constructor(private d: Database) {}

  /** Every workspace in display order (`position ASC`); editing a board never moves it, only `reorder` does. */
  list(): Workspace[] {
    const rows = this.d.query(`${SELECT_WS} ${ORDER_WS}`).all() as Row[]
    return rows.map((r, i) => ({ ...toWorkspace(r), position: r.position ?? i }))
  }

  /**
   * One page of the sidebar view, newest first. Keyset order (`updated_at DESC, id DESC`, both in
   * the cursor) is stable while rows are saved between pages: no skipped or repeated rows from
   * OFFSET drift. `limit` is clamped by the caller (route).
   */
  listSummaries(limit: number, cursor?: string): WorkspaceSummaryPage {
    const after = cursor ? decodeSummaryCursor(cursor) : null
    const rows = (after
      ? this.d.query(`${SELECT_WS} WHERE w.updated_at < ?1 OR (w.updated_at = ?1 AND w.id < ?2) ORDER BY w.updated_at DESC, w.id DESC LIMIT ?3`).all(after.updatedAt, after.id, limit + 1)
      : this.d.query(`${SELECT_WS} ORDER BY w.updated_at DESC, w.id DESC LIMIT ?1`).all(limit + 1)) as Row[]
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
    const row = this.d.query(`${SELECT_WS} WHERE w.id = ?`).get(id) as Row | null
    return row ? toWorkspace(row) : null
  }

  /** Hue ids of every stored workspace (one per row, repeats kept): what `pickWorkspaceColor` avoids. */
  usedHues(): string[] {
    return (this.d.query('SELECT color FROM workspace').all() as { color: string | null }[]).flatMap((r) => (r.color ? [r.color] : []))
  }

  /** `<hue> <shade>` per workspace id ("blue vivid"): what Central's state header shows next to each workspace. */
  colorMap(): Map<string, string> {
    const rows = this.d.query('SELECT id, color, color_shade FROM workspace').all() as { id: string; color: string | null; color_shade: string }[]
    return new Map(rows.flatMap((r) => (r.color ? [[r.id, describeWorkspaceColor(r.color, r.color_shade)] as [string, string]] : [])))
  }

  /** New workspace; without `color` it gets a random hue no other workspace uses (the single create point for every path). */
  create(name: string, cwd?: string, color?: string, colorShade?: WorkspaceShade): Workspace {
    const ws: Workspace = {
      id: crypto.randomUUID(),
      name,
      cwd,
      color: color ?? pickWorkspaceColor(this.usedHues(), Math.random),
      colorShade: colorShade ?? DEFAULT_WORKSPACE_SHADE,
      viewport: DEFAULT_VIEWPORT,
      nodes: [],
      bridges: [],
      layout: defaultTabLayout(),
      updatedAt: Date.now(),
    }
    this.immediate(() => {
      this.d.query(
        'INSERT INTO workspace (id, name, cwd, color, color_shade, viewport, nodes, bridges, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ws.id, ws.name, ws.cwd ?? null, ws.color ?? null, ws.colorShade ?? DEFAULT_WORKSPACE_SHADE, JSON.stringify(ws.viewport), this.nodesColumn(ws.id, ws.nodes), JSON.stringify(ws.bridges), ws.updatedAt)
      appendPosition(this.d, ws.id) // new boards go to the end, in the same transaction as the row
    })
    return this.get(ws.id) ?? ws // re-read: carries the stored `position`
  }

  /**
   * The value of the `nodes` column for a write of `incoming` to row `id`: the stored row's preserved
   * (unreadable) nodes ride along unless `incoming` reuses their id. EVERY write of the column goes
   * through here (db.preserveNodes policy test); the caller holds the write transaction, so the
   * stored nodes read here are the ones the write replaces. Also the single naming point: every
   * stored node gets a unique handle (`withNodeNames`), whoever wrote the board.
   */
  private nodesColumn(id: string, incoming: readonly WsNode[]): string {
    const row = this.d.query('SELECT nodes FROM workspace WHERE id = ?').get(id) as Pick<Row, 'nodes'> | null
    const stored = row ? parseColumn(row.nodes, '[]') : []
    return JSON.stringify(withPreservedNodes(withNodeNames(lockNodePresets(incoming, splitNodes(stored).nodes)), stored))
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
        `UPDATE workspace SET name=?1, cwd=?2, viewport=?3, nodes=?4, bridges=?5,
           layout=COALESCE(NULLIF(?6, ''), layout), updated_at=MAX(?7, updated_at + 1)
         WHERE id=?8 AND (?9 IS NULL OR updated_at <= ?9)`
      ).run(ws.name, ws.cwd ?? null, JSON.stringify(ws.viewport), this.nodesColumn(ws.id, ws.nodes), JSON.stringify(ws.bridges), serializeLayout(ws.layout), Date.now(), ws.id, base ?? null)
      if (r.changes > 0) return 'saved'
      return this.d.query('SELECT 1 FROM workspace WHERE id = ?').get(ws.id) ? 'stale' : 'missing'
    })
  }

  /**
   * Set a workspace's color. Colors are written ONLY here (and by `create`), never by a board save:
   * a window holding an older copy of the board cannot revert a color another window or Central just
   * chose. `updated_at` is left alone so nobody's unsent board save turns into a 409.
   */
  setColor(id: string, color: WorkspaceHue, shade: WorkspaceShade): boolean {
    return this.immediate(() => {
      const ws = this.get(id)
      if (!ws) return false
      // `nodes` rides along through nodesColumn like every other write (db.preserveNodes policy): unchanged, preserved ones kept.
      return this.d.query('UPDATE workspace SET color=?1, color_shade=?2, nodes=?3 WHERE id=?4')
        .run(color, shade, this.nodesColumn(id, ws.nodes), id).changes > 0
    })
  }

  /**
   * Migration step: every row whose `color` is not a palette hue (NULL, or legacy free text nothing in the UI wrote)
   * gets a hue derived from its id, so an old workspace keeps one color on every boot instead of a random one per load.
   * Idempotent: after the first run no row matches.
   */
  backfillColors(): void {
    const rows = this.d.query('SELECT id, color FROM workspace').all() as { id: string; color: string | null }[]
    for (const r of rows) if (!isWorkspaceHue(r.color)) this.setColor(r.id, backfillWorkspaceHue(r.id), DEFAULT_WORKSPACE_SHADE)
  }

  delete(id: string): void {
    this.immediate(() => {
      this.d.query('DELETE FROM workspace WHERE id = ?').run(id)
      dropPosition(this.d, id) // close the gap in the same transaction
    })
  }

  /** Replace the display order with `ids` (every stored id once); a refusal changes nothing. Touches no board row or `updated_at`. */
  reorder(ids: readonly string[]): { ok: true } | { ok: false; reason: WorkspaceOrderReason } {
    const reason = this.immediate(() => applyOrder(this.d, ids))
    return reason ? { ok: false, reason } : { ok: true }
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
    return parseStored(this.storedSettingsJson())
  }

  /** A one-time marker kept in the `app` table (boot migrations); null = never set. */
  getAppFlag(key: string): string | null {
    const row = this.d.query('SELECT value FROM app WHERE key = ?').get(key) as { value: string } | null
    return row ? row.value : null
  }

  setAppFlag(key: string, value: string): void {
    this.d.query('INSERT INTO app (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  /** The raw stored settings row (null = never written); boot backfills inspect stored keys with it. */
  storedSettingsJson(): string | null {
    const row = this.d.query("SELECT value FROM app WHERE key = 'settings'").get() as { value: string } | null
    return row ? row.value : null
  }

  /** Patch the RAW stored document (`nextSettingsDocument`), write it, return the normalized view. Sinkron dari ujung
   *  ke ujung — lihat catatan di `settingsStore.ts` soal kenapa tidak ada rantai tulis. */
  saveSettings(patch: unknown): Settings {
    const row = this.d.query("SELECT value FROM app WHERE key = 'settings'").get() as { value: string } | null
    // The provider's command-mode profile lives in its own config, so the store is told which id it holds.
    const next = nextSettingsDocument(row ? row.value : null, patch, { providerProfileId: commandProfileOverride() })
    this.d.query(
      "INSERT INTO app (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(JSON.stringify(next.doc))
    return next.settings
  }

  /** Browser profile registry (own table `browser_profile`). */
  browserProfiles(): BrowserProfileStore { return createBrowserProfileStore(this.d) }

  /** Shutdown only (index.ts exit hook): later calls on this store throw. Cast like ledgerRuntime.ts: the local bun:sqlite type omits close. */
  close(): void { (this.d as unknown as { close(): void }).close() }
}

export const db = new Db(openDb())

// Agent custom mewarisi kapabilitas harness lewat `baseAgent`; resolvernya harus didaftarkan
// sekali per runtime (lihat `shared/workspace.ts`). Di sini, bukan di entry server, karena ini
// satu-satunya modul yang memegang store settings sisi server.
registerAgentBaseResolver(() => db.getSettings())
registerClaudeLaunchSettings(() => db.getSettings())
registerModelSettings(() => db.getSettings()) // per-project model override (models/modelOverride.ts)
registerDefaultProfileOverride(() => commandProfileOverride()) // Claude provider command mode picks the default launch profile
