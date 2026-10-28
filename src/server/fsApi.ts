// Permukaan HTTP untuk 6 method `FsApi` di `fsOps.ts`. Di nodeterm ini enam channel IPC
// (`IPC.fsList`, `IPC.fsRead`, …) yang didaftarkan `registerFsHandlers`; di webterm ia enam
// subpath di bawah `/api/fs/`.
//
// SENGAJA DI BAWAH `/api/fs/<verb>`, BUKAN MENGGANTI `/api/fs`. `/api/fs` persis (tanpa subpath)
// adalah folder picker yang sudah berjalan (`src/client/FolderPicker.tsx` → `api.listDir`), dan
// bentuk responsnya berbeda (`{ path, parent, dirs }`). Menumpuk keduanya di satu path berarti
// satu endpoint dengan dua kontrak; memberi ruang di subpath membuat wiring-nya satu baris dan
// tidak merusak picker.
//
// Otorisasi TIDAK terjadi di sini: `src/server/index.ts` sudah menggerbangi SELURUH `/api/*`
// dengan `authorize()` (Origin + token) sebelum `handleApi` dipanggil. Lihat juga catatan
// keamanan path di kepala `fsOps.ts`.
import { listDir, makeDir, pathExists, readBinary, readText, writeText } from './fsOps'

/** Status + body JSON untuk dijawab pemanggil, atau `null` bila path bukan milik modul ini. */
export type FsApiResult = { status: number; body: unknown } | null

const BAD_PATH = { status: 400, body: { error: 'path required' } }

/** Path dari query string, atau `null` bila tidak ada/kosong. Batas input: nilainya mendarat di
 *  `fs.*`, jadi tipe saja tidak cukup — query param selalu bisa hilang atau kosong. */
function pathParam(params: URLSearchParams): string | null {
  const p = params.get('path')
  return typeof p === 'string' && p.trim() !== '' ? p : null
}

function parseBody(raw: string): { path?: unknown; content?: unknown } | null {
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null // body bukan JSON — 400, bukan crash
  }
}

/**
 * Rute satu request `/api/fs/<verb>`. Mengembalikan `null` untuk path lain supaya pemanggil
 * jatuh ke rutenya sendiri.
 *
 * `body` adalah getter, bukan string: hanya dua verb yang punya body, dan membaca stream request
 * untuk GET akan menggantung sampai timeout.
 */
export async function fsApiRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  body: () => Promise<string>
): Promise<FsApiResult> {
  if (!path.startsWith('/api/fs/')) return null
  const verb = path.slice('/api/fs/'.length)

  if (method === 'GET') {
    const target = pathParam(params)
    switch (verb) {
      case 'list':
        if (!target) return BAD_PATH
        return { status: 200, body: await listDir(target) }
      case 'read':
        if (!target) return BAD_PATH
        return { status: 200, body: { content: await readText(target) } }
      case 'read-binary':
        if (!target) return BAD_PATH
        return { status: 200, body: { base64: await readBinary(target) } }
      case 'exists':
        if (!target) return BAD_PATH
        return { status: 200, body: { exists: await pathExists(target) } }
    }
  }

  if (method === 'POST' && (verb === 'write' || verb === 'mkdir')) {
    const parsed = parseBody(await body())
    if (!parsed) return { status: 400, body: { error: 'bad json' } }
    const target = typeof parsed.path === 'string' && parsed.path.trim() !== '' ? parsed.path : null
    if (!target) return BAD_PATH
    if (verb === 'mkdir') return { status: 200, body: { ok: await makeDir(target) } }
    // Konten WAJIB string: `fs.writeFile` menerima objek apa pun yang punya `toString`, jadi
    // body yang salah bentuk akan menulis "[object Object]" ke file pengguna, bukan gagal.
    if (typeof parsed.content !== 'string') return { status: 400, body: { error: 'content must be a string' } }
    return { status: 200, body: { ok: await writeText(target, parsed.content) } }
  }

  return { status: 404, body: { error: 'unknown fs route' } }
}
