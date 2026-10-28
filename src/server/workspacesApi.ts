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

/** Status + body JSON untuk dijawab pemanggil (`body` absen = 204-style, tanpa isi), atau `null`
 *  bila path/method bukan milik modul ini. */
export type WorkspacesResult = { status: number; body?: unknown } | null

const BAD_JSON = { status: 400, body: { error: 'bad json' } }
const NOT_FOUND = { status: 404, body: { error: 'not found' } }

type CreateBody = { name: string; cwd?: string; color?: string }
type SaveBody = CreateBody & { viewport: Viewport; nodes: WsNode[]; bridges?: BridgeLink[] }

/**
 * Rute satu request workspace. `store` di-inject (bukan import singleton `db`) supaya tabel rute
 * ini bisa diuji di atas SQLite in-memory tanpa menyentuh DB pengguna.
 *
 * `body` adalah getter, bukan string: hanya POST/PUT punya body, dan membaca stream request untuk
 * GET akan menggantung sampai timeout.
 */
export async function workspacesRoute(
  store: Db,
  path: string,
  method: string,
  body: () => Promise<string>
): Promise<WorkspacesResult> {
  if (path === '/api/workspaces') {
    if (method === 'GET') return { status: 200, body: store.list() }
    if (method === 'POST') {
      let b: CreateBody
      try { b = JSON.parse(await body()) as CreateBody } catch { return BAD_JSON }
      return { status: 201, body: store.create(b.name, b.cwd, b.color) }
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
      let b: SaveBody
      try { b = JSON.parse(await body()) as SaveBody } catch { return BAD_JSON }
      const ws: Workspace = {
        id, name: b.name, cwd: b.cwd, color: b.color,
        viewport: b.viewport, nodes: b.nodes, bridges: b.bridges ?? [], updatedAt: Date.now(),
      }
      store.save(ws)
      const saved = store.get(id)
      return saved ? { status: 200, body: saved } : NOT_FOUND
    }
    if (method === 'DELETE') {
      store.delete(id)
      return { status: 204 } // tanpa kunci `body` — lihat catatan 204 di kepala file
    }
  }

  if (path === '/api/active') {
    if (method === 'GET') return { status: 200, body: { id: store.getActive() } }
    if (method === 'PUT') {
      let b: { id: string }
      try { b = JSON.parse(await body()) as { id: string } } catch { return BAD_JSON }
      store.setActive(b.id)
      return { status: 204 }
    }
  }

  return null
}
