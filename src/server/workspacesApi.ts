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
import type { BridgeLink, Viewport, Workspace, WsNode } from '../shared/workspace'
import type { Db } from './db'
import { BodyReadError } from './cappedRequestBody'
import { logWorkspaceSave, workspaceLog } from './workspacesLog'
import { guardWorkspaceRepos } from './repoHygiene'
import { produceEdgeChange } from './events/producers.edge'
import { backgroundsDir } from './canvasBackground.store'
import { dropWorkspaceBackground } from './canvasBackground.gc'

/** Status + body JSON untuk dijawab pemanggil (`body` absen = 204-style, tanpa isi), atau `null`
 *  bila path/method bukan milik modul ini. */
export type WorkspacesResult = { status: number; body?: unknown } | null

const BAD_JSON = { status: 400, body: { error: 'bad json' } }
const NOT_FOUND = { status: 404, body: { error: 'not found' } }
const BAD_ID = { status: 400, body: { error: 'id must be a non-empty string' } }
const TOO_LARGE = { status: 413, body: { error: 'payload_too_large' } }
const BODY_READ_FAILED = { status: 400, body: { error: 'body_read_failed' } }

type CreateBody = { name: string; cwd?: string; color?: string }
type SaveBody = CreateBody & { viewport: Viewport; nodes: WsNode[]; bridges?: BridgeLink[] }

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
 */
export async function workspacesRoute(
  store: Db,
  path: string,
  method: string,
  body: () => Promise<string>,
  bgDir: () => string = backgroundsDir
): Promise<WorkspacesResult> {
  if (path === '/api/workspaces') {
    if (method === 'GET') return { status: 200, body: store.list() }
    if (method === 'POST') {
      const read = await bodyOrFailure(body)
      if (!read.ok) return read.result
      const b = parseObjectBody<CreateBody>(read.raw)
      if (!b) return BAD_JSON
      const created = guarded('create', undefined, () => store.create(b.name, b.cwd, b.color))
      workspaceLog.created(created)
      void guardWorkspaceRepos([created]) // secrets guard without a restart; never throws per repo
      return { status: 201, body: created }
    }
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
      const ws: Workspace = {
        id, name: b.name, cwd: b.cwd, color: b.color,
        viewport: b.viewport, nodes: b.nodes, bridges: b.bridges ?? [], updatedAt: Date.now(),
      }
      const prev = store.get(id)
      guarded('save', id, () => store.save(ws))
      const saved = store.get(id)
      if (saved) logWorkspaceSave(prev, saved)
      if (saved) produceEdgeChange(prev, saved) // linkNote + wake subscribe to this, not a poll
      if (saved && saved.cwd !== prev?.cwd) void guardWorkspaceRepos([saved]) // cwd changed: guard the new repo
      return saved ? { status: 200, body: saved } : NOT_FOUND
    }
    if (method === 'DELETE') {
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
