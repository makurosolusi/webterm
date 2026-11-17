// Rute keluarga workspace: `/api/workspaces`, `/api/workspaces/:id`, `/api/active`. Dipisah dari
// `api.ts` supaya file itu tetap di bawah budget rute dan hanya berisi tabel routing + perekat
// respons.
//
// Konvensi SAMA dengan `fsApi.ts`: kembalikan `{ status, body }` dan biarkan pemanggil yang
// menyentuh `ServerResponse`, `null` berarti "bukan punyaku, lanjut ke rute berikutnya". Dua rute
// di sini menjawab 204, jadi `body` di tipe hasil OPSIONAL: tanpa kunci `body` berarti pemanggil
// menutup respons tanpa isi sama sekali. Body JSON di 204 adalah perubahan kontrak — sebagian
// client membaca 204 sebagai pasti-kosong dan menganggap isinya error.
//
// Otorisasi TIDAK terjadi di sini: `src/server/index.ts` sudah menggerbangi SELURUH `/api/*`
// dengan `authorize()` (Origin + token) sebelum `handleApi` dipanggil.
import { stat } from 'node:fs/promises'
import type { Workspace } from '../shared/workspace'
import { normalizeWorkspace } from '../shared/workspace.schema'
import type { Db } from './db'
import { decodeSummaryCursor, parseSummaryLimit } from './db.summary'
import { expandHomePath } from './fsOps'
import { BodyReadError } from './cappedRequestBody'
import { logWorkspaceSave, workspaceLog } from './workspacesLog'
import { guardWorkspaceRepos } from './repoHygiene'
import { produceEdgeChange } from './events/producers.edge'
import { normalizeTabLayout } from '../shared/tabLayout.schema'
import { backgroundsDir } from './canvasBackground.store'
import { dropWorkspaceBackground } from './canvasBackground.gc'
import { isWorkspaceHue, isWorkspaceShade } from '../shared/workspaceColor'
import type { WorkspaceShade } from '../shared/workspaceColor'
import { setWorkspaceColor } from './workspaceColor'
import { closeRemovedAgentChats, closeWorkspaceAgentChats } from './agentChat/agentChat.pool'

/** Status + body JSON untuk dijawab pemanggil (`body` absen = 204-style, tanpa isi), atau `null`
 *  bila path/method bukan milik modul ini. */
export type WorkspacesResult = { status: number; body?: unknown } | null

const BAD_JSON = { status: 400, body: { error: 'bad json' } }
const NOT_FOUND = { status: 404, body: { error: 'not found' } }
const BAD_ID = { status: 400, body: { error: 'id must be a non-empty string' } }
const TOO_LARGE = { status: 413, body: { error: 'payload_too_large' } }
const BODY_READ_FAILED = { status: 400, body: { error: 'body_read_failed' } }

const BAD_NAME = { status: 400, body: { error: 'name must be a non-empty string' } }
const BAD_CWD = { status: 400, body: { error: 'cwd must be an existing directory' } }
const BAD_COLOR = { status: 400, body: { error: 'color must be a palette hue id' } }
const BAD_SHADE = { status: 400, body: { error: 'colorShade must be soft, default or vivid' } }
const BAD_COLOR_EMPTY = { status: 400, body: { error: 'send color, colorShade or random' } }
const BAD_LIMIT = { status: 400, body: { error: 'limit must be an integer from 1 to 200' } }
const BAD_CURSOR = { status: 400, body: { error: 'cursor is not valid' } }

/** `updatedAt` = the version the writer last saw (precondition, see `Db.save`), not a timestamp. */
type SaveBody = Record<string, unknown> & { layout?: unknown; updatedAt?: unknown }

/** True when `cwd` (`~` expanded, like the PTY does) is a directory this process can stat. */
async function isDirectory(cwd: string): Promise<boolean> {
  try {
    return (await stat(expandHomePath(cwd))).isDirectory()
  } catch {
    return false // ENOENT/ENOTDIR/EACCES: all mean "a shell cannot start there" -> 400, not 500
  }
}

/** The 400 for each create field `createFields` can refuse. */
const BAD_FIELD = { name: BAD_NAME, cwd: BAD_CWD, color: BAD_COLOR, shade: BAD_SHADE } as const
export type CreateRefusal = keyof typeof BAD_FIELD

/** Create body -> fields, or the first bad field (values never echoed). */
async function createFields(b: Record<string, unknown>): Promise<{ name: string; cwd?: string; color?: string; colorShade?: WorkspaceShade } | { bad: CreateRefusal }> {
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return { bad: 'name' }
  const cwd = b.cwd === undefined || b.cwd === null || b.cwd === '' ? undefined : b.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !(await isDirectory(cwd)))) return { bad: 'cwd' }
  // Palette ids only (shared/workspaceColor.ts); absent = the server picks an unused hue at create.
  if (b.color != null && !isWorkspaceHue(b.color)) return { bad: 'color' }
  if (b.colorShade != null && !isWorkspaceShade(b.colorShade)) return { bad: 'shade' }
  return { name, cwd, color: b.color ?? undefined, colorShade: b.colorShade ?? undefined }
}

/** The human create (POST `/api/workspaces`) without HTTP: validate, store, log, secrets guard. Central's `workspace.create` calls it too. */
export async function createWorkspaceFrom(store: Db, b: Record<string, unknown>): Promise<{ ok: true; workspace: Workspace } | { ok: false; bad: CreateRefusal }> {
  const f = await createFields(b)
  if ('bad' in f) return { ok: false, bad: f.bad }
  const created = guarded('create', undefined, () => store.create(f.name, f.cwd, f.color, f.colorShade))
  afterCommit('create log', created.id, () => workspaceLog.created(created))
  void guardWorkspaceRepos([created]) // secrets guard without a restart; never throws per repo
  return { ok: true, workspace: created }
}

/** Run a post-commit side effect: the write already succeeded, so a throw is logged, never a 500. */
function afterCommit(step: string, id: string, run: () => void): void {
  try {
    run()
  } catch (err) {
    workspaceLog.sideEffectFailed(step, id, err)
  }
}

/** `GET /api/workspaces?summary=1`: one page of `WorkspaceSummaryPage` (limit/cursor checked here). */
function summaryPage(store: Db, query: URLSearchParams): WorkspacesResult {
  const limit = parseSummaryLimit(query.get('limit'))
  if (limit === null) return BAD_LIMIT
  const cursor = query.get('cursor') || undefined
  if (cursor && !decodeSummaryCursor(cursor)) return BAD_CURSOR
  return { status: 200, body: store.listSummaries(limit, cursor) }
}

/**
 * Body JSON yang WAJIB objek biasa, atau `null` → 400.
 *
 * `JSON.parse` saja tidak cukup: `null`, `42`, `"teks"`, dan `[]` adalah JSON SAH, jadi
 * `try/catch` di sekitarnya lolos, lalu pembacaan properti melempar di runtime (`b.name` pada
 * `null`) atau meneruskan `undefined` ke store. Pola sama dengan `parseBody` di `fsApi.ts`;
 * disalin, bukan dibagi, karena tipe di sana sempit untuk verb fs-nya sendiri.
 *
 * `T` tetap sebuah janji ke compiler soal BENTUK FIELD yang tidak diperiksa di sini — penjaga ini
 * hanya menjamin "ini objek". Field yang hilang/salah tipe masih mungkin lewat.
 */
function parseObjectBody<T>(raw: string): T | null {
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null
  } catch {
    return null // bukan JSON sama sekali
  }
}

/**
 * Baca body lewat getter, lalu petakan penolakan intake ke jawaban HTTP-nya.
 *
 * Getter-nya milik pemanggil (`cappedBodyGetter` di `api.ts`), jadi cap 1 MiB ditegakkan di sana
 * saat streaming — modul ini tidak perlu tahu soal byte. `BodyReadError` = cap/stream menolak;
 * error lain (bug) tetap naik ke penangan 500 di `api.ts` alih-alih disamarkan jadi 400.
 */
async function bodyOrFailure(
  body: () => Promise<string>
): Promise<{ ok: true; raw: string } | { ok: false; result: WorkspacesResult }> {
  try {
    return { ok: true, raw: await body() }
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    return { ok: false, result: err.reason === 'too_large' ? TOO_LARGE : BODY_READ_FAILED }
  }
}

/** Jalankan tulis-DB; kegagalan dicatat (error) lalu dilempar ulang ke penangan 500 di `api.ts`. */
function guarded<T>(op: 'create' | 'save' | 'delete', id: string | undefined, run: () => T): T {
  try {
    return run()
  } catch (err) {
    workspaceLog.failed(op, id, err)
    throw err
  }
}

/**
 * Rute satu request workspace. `store` di-inject (bukan import singleton `db`) supaya tabel rute
 * ini bisa diuji di atas SQLite in-memory tanpa menyentuh DB pengguna.
 *
 * `body` adalah getter, bukan string: hanya POST/PUT punya body, dan membaca stream request untuk
 * GET akan menggantung sampai timeout.
 *
 * `bgDir` = wallpaper dir (lazy, injectable for tests); a delete drops the workspace's override.
 * `query` = the request's search params (`?summary=1&limit&cursor` on the list).
 */
export async function workspacesRoute(
  store: Db,
  path: string,
  method: string,
  body: () => Promise<string>,
  bgDir: () => string = backgroundsDir,
  query: URLSearchParams = new URLSearchParams()
): Promise<WorkspacesResult> {
  if (path === '/api/workspaces') {
    if (method === 'GET') return query.get('summary') === '1' ? summaryPage(store, query) : { status: 200, body: store.list() }
    if (method === 'POST') {
      const read = await bodyOrFailure(body)
      if (!read.ok) return read.result
      const b = parseObjectBody<Record<string, unknown>>(read.raw)
      if (!b) return BAD_JSON
      const r = await createWorkspaceFrom(store, b)
      return r.ok ? { status: 201, body: r.workspace } : BAD_FIELD[r.bad]
    }
  }

  // Color has its own route (not the board PUT): a window with an older board copy must not revert it.
  // PUT, not PATCH: partial updates in this API (settings) are PUTs too.
  const colorMatch = path.match(/^\/api\/workspaces\/([^/]+)\/color$/)
  if (colorMatch && method === 'PUT') {
    const read = await bodyOrFailure(body)
    if (!read.ok) return read.result
    const b = parseObjectBody<Record<string, unknown>>(read.raw)
    if (!b) return BAD_JSON
    const { broadcastUi } = await import('./canvas/canvasPush.runtime')
    const r = setWorkspaceColor(store, decodeURIComponent(colorMatch[1]), b, broadcastUi)
    if (r.ok) return { status: 200, body: { color: r.change.color, colorShade: r.change.shade } }
    return r.bad === 'not_found' ? NOT_FOUND : r.bad === 'shade' ? BAD_SHADE : r.bad === 'empty' ? BAD_COLOR_EMPTY : BAD_COLOR
  }

  const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/)
  if (wsMatch) {
    const id = decodeURIComponent(wsMatch[1])
    if (method === 'GET') {
      const ws = store.get(id)
      return ws ? { status: 200, body: ws } : NOT_FOUND
    }
    if (method === 'PUT') {
      const read = await bodyOrFailure(body)
      if (!read.ok) return read.result
      const b = parseObjectBody<SaveBody>(read.raw)
      if (!b) return BAD_JSON
      // Shared schema (also used on read): refuse rather than store a board that needed repair, so
      // a bad writer gets a 400 naming the fields and the stored row stays exactly as it was.
      const { board, issues } = normalizeWorkspace(b)
      if (issues.length > 0) return { status: 400, body: { error: 'invalid workspace', issues } }
      const ws: Workspace = {
        id, ...board, updatedAt: Date.now(),
        // Absent = keep the stored layout (old clients, partial writers); present = sanitized.
        layout: b.layout === undefined ? undefined : normalizeTabLayout(b.layout),
      }
      const prev = store.get(id)
      const base = typeof b.updatedAt === 'number' && Number.isFinite(b.updatedAt) ? b.updatedAt : undefined
      const outcome = guarded('save', id, () => store.save(ws, base))
      // PUT only updates: an unknown id (deleted in another window) is 404, never a re-create.
      if (outcome === 'missing') { workspaceLog.refused(id, outcome); return NOT_FOUND }
      // Another writer saved after this one's base: hand back the current board so the client
      // reloads it (VS Code "file changed on disk") instead of silently overwriting it.
      if (outcome === 'stale') { workspaceLog.refused(id, outcome); return { status: 409, body: { code: 'stale', current: store.get(id) } } }
      const saved = store.get(id)
      if (!saved) return NOT_FOUND
      // Committed: log + event never change the answer (a throw there used to turn a stored save into a 500).
      afterCommit('save log', id, () => logWorkspaceSave(prev, saved))
      afterCommit('agent chat close', id, () => closeRemovedAgentChats(prev, saved)) // removed chat nodes stop their Claude process
      afterCommit('edge event', id, () => produceEdgeChange(prev, saved)) // linkNote + wake subscribe to this, not a poll
      if (saved.cwd !== prev?.cwd) void guardWorkspaceRepos([saved]) // cwd changed: guard the new repo
      return { status: 200, body: saved }
    }
    if (method === 'DELETE') {
      const { sessions } = await import('./sessions')
      closeWorkspaceAgentChats(store.get(id)) // its chat nodes stop their Claude process (lazily recreated if the delete fails)
      sessions.closeNodes(store.get(id)?.nodes ?? []) // ops-212-3: its shells/agents end with it
      guarded('delete', id, () => store.delete(id))
      workspaceLog.deleted(id)
      await dropWorkspaceBackground(store, id, bgDir) // never throws: logs a warning on failure
      return { status: 204 } // tanpa kunci `body` — lihat catatan 204 di kepala file
    }
  }

  if (path === '/api/active') {
    if (method === 'GET') return { status: 200, body: { id: store.getActive() } }
    if (method === 'PUT') {
      const read = await bodyOrFailure(body)
      if (!read.ok) return read.result
      const b = parseObjectBody<{ id?: unknown }>(read.raw)
      if (!b) return BAD_JSON
      // Bentuk penjaga sama dengan `pathParam` di `fsApi.ts`: tipe saja tidak cukup karena
      // `parseObjectBody` hanya menjamin "ini objek". Tanpa ini `{}` lolos, `undefined` terikat
      // sebagai NULL di SQLite, dan rute menjawab 204 SAMBIL menghapus workspace aktif pengguna —
      // kegagalan senyap yang merusak state. Pesan tidak menggemakan nilai yang dikirim client.
      if (typeof b.id !== 'string' || b.id.trim() === '') return BAD_ID
      store.setActive(b.id)
      workspaceLog.activated(b.id)
      return { status: 204 }
    }
  }

  return null
}
