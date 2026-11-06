// Enam method filesystem lewat `/api/fs/*` (server: `src/server/fsApi.ts`). Di nodeterm ini
// `window.api.fs.*` di atas IPC Electron; di sini fetch same-origin.
//
// Token dikirim lewat query `?token=` memakai `tokenQuery()` yang sudah diekspor `./api`, BUKAN
// header: header akan menuntut menyentuh `./api` (di luar kepemilikan), dan `authorize()` di
// `src/server/auth.ts` menerima kedua jalur untuk seluruh `/api/*`.
//
// DUA KONTRAK ERROR, dan bedanya sengaja:
//
// 1. PENELUSURAN (`list`, `exists`) FAIL-OPEN, sama seperti sisi server (lihat kontrak di kepala
//    `src/server/fsOps.ts`): request yang gagal — jaringan mati, 4xx, JSON rusak — menjawab nilai
//    kosong yang sama dengan "tidak ada di sana", karena `classifyEmptyListing` di `./fileBrowse`
//    dirancang untuk MEMBEDAKAN keduanya dengan bertanya ke direktori INDUK, bukan dari error.
//    Mengubahnya jadi throw akan meruntuhkan empat empty state di UI jadi satu pesan error.
//
// 2. PEMBACAAN ISI (`read`, `readBinary`) MELEMPAR. Di sini fail-open berbohong: untuk sebuah file,
//    '' juga arti sah "file ini memang kosong", jadi mengembalikan '' saat gagal baca membuat node
//    editor membuka buffer kosong yang BISA DISIMPAN — satu ⌘S lalu menimpa file asli pengguna
//    dengan nol byte. Kehilangan data, bukan cuma pesan yang kurang. Karena itu kegagalan keluar
//    sebagai `Error` bercontext (operasi + path + penyebab asal) dan '' hanya berarti kosong.
//
// Sentinel too-large (`nodeterm:too-large:` lewat `src/shared/fsLimits.ts`) BUKAN kegagalan: ia
// jawaban sukses yang disengaja dan bagian wire-protocol — lewat apa adanya ke pemanggil.
//
// `write`/`mkdir` mengembalikan boolean ok seperti sebelumnya. Tiap catch mengembalikan atau
// melempar nilai yang didokumentasikan, bukan `catch {}` kosong.
//
// KONTRAK 3 (verb baru, PLAN/FILEMANAGER-b.md §5): `FsResult` — TIDAK PERNAH melempar. `FsFail`
// di-parse dari body walau status non-2xx (409/413/501...); jaringan/JSON rusak jadi `EIO`.
import { fsFail, type FsCapabilities, type FsFail, type FsResult, type FileMeta, type FsVersion, type GitStatus, type ListV2, type ReadMeta } from '../shared/fsContract'
import { tokenQuery } from './api'
import { onReconnect } from './ws'
import type { DirEntry } from './fileBrowse'

function url(verb: string, params?: Record<string, string>): string {
  const q = new URLSearchParams(params)
  const token = tokenQuery()
  return `/api/fs/${verb}${q.size || token ? '?' : ''}${[q.toString(), token].filter(Boolean).join('&')}`
}

/** Satu GET ber-JSON yang MELEMPAR; dasar kedua kontrak di atas. Semua penyebab (jaringan, status
 *  non-2xx, JSON rusak) keluar sebagai satu `Error` yang menyebut operasi, path, dan penyebab
 *  aslinya — pemanggil tidak perlu membedakan jenisnya, hanya menampilkannya. */
async function getStrict<T>(verb: string, params: Record<string, string>): Promise<T> {
  try {
    const res = await fetch(url(verb, params))
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || 'error'}`)
    return (await res.json()) as T
  } catch (e) {
    throw new Error(`fs ${verb} "${params.path ?? ''}": ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Varian fail-open untuk penelusuran: `getStrict` lalu nilai `fallback` yang didokumentasikan. */
async function get<T>(verb: string, params: Record<string, string>, fallback: T): Promise<T> {
  try {
    return await getStrict<T>(verb, params)
  } catch {
    // Kontrak 1: kegagalan penelusuran SENGAJA tak dapat dibedakan dari "tidak ada di sana" —
    // `classifyEmptyListing` yang memutuskan artinya, lewat direktori induk.
    return fallback
  }
}

function isFsFail(v: unknown): v is FsFail {
  const f = v as Partial<FsFail> | null
  return !!f && typeof f === 'object' && f.ok === false && typeof f.code === 'string' && typeof f.error === 'string'
}

/** Satu request ber-`FsResult` (kontrak 3): tak pernah melempar; `init` kosong = GET. */
async function call<T extends object = object>(verb: string, params: Record<string, string>, init?: RequestInit): Promise<FsResult<T>> {
  try {
    const res = await fetch(url(verb, params), init)
    // Proxy/HTML error page: body bukan JSON, tapi statusnya tetap informasi yang berguna.
    const json: unknown = await res.json().catch(() => null)
    if (isFsFail(json)) return json
    if (res.ok && (json as { ok?: unknown } | null)?.ok === true) return json as FsResult<T>
    return fsFail('EIO', `fs ${verb}: HTTP ${res.status} ${res.statusText || 'error'}`)
  } catch (e) {
    return fsFail('EIO', `fs ${verb}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const postJson = <T extends object = object>(verb: string, body: unknown): Promise<FsResult<T>> =>
  call<T>(verb, {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function post(verb: string, body: unknown): Promise<boolean> {
  return (await postJson(verb, body)).ok
}

/** Isi direktori: folder dulu lalu file, `.git` disembunyikan, entry gitignored ditandai. `[]`
 *  bila direktori tidak ada ATAU memang kosong — `classifyEmptyListing` yang membedakannya. */
export function list(path: string): Promise<DirEntry[]> {
  return get<DirEntry[]>('list', { path }, [])
}

/** Isi UTF-8 sebuah file. MELEMPAR bila gagal baca — `''` berarti file itu memang kosong. Sentinel
 *  `tooLargeSentinel` bila lewat cap: itu sukses, pemanggil memeriksanya dengan `tooLargeSize()`
 *  dari `src/shared/fsLimits.ts`. */
export async function read(path: string): Promise<string> {
  const { content } = await getStrict<{ content?: string }>('read', { path })
  // Field hilang = respons bukan jawaban read yang sah. Dibiarkan jadi '' akan menghidupkan lagi
  // persis bug buffer-kosong-yang-bisa-disimpan yang kontrak ini tutup.
  if (typeof content !== 'string') throw new Error(`fs read "${path}": response has no content field`)
  return content
}

/** Isi file sebagai base64 (gambar/biner). MELEMPAR bila gagal baca, sentinel bila lewat cap biner. */
export async function readBinary(path: string): Promise<string> {
  const { base64 } = await getStrict<{ base64?: string }>('read-binary', { path })
  if (typeof base64 !== 'string') throw new Error(`fs read-binary "${path}": response has no base64 field`)
  return base64
}

export async function exists(path: string): Promise<boolean> {
  return (await get<{ exists?: boolean }>('exists', { path }, {})).exists === true
}

export function write(path: string, content: string): Promise<boolean> {
  return post('write', { path, content })
}

/** Buat direktori, rekursif (`mkdir -p`). */
export function mkdir(path: string): Promise<boolean> {
  return post('mkdir', { path })
}

/** `read` + `version`/`encoding` (untuk `expectedVersion` saat simpan). MELEMPAR seperti `read`. */
export async function readMeta(path: string): Promise<ReadMeta> {
  const m = await getStrict<Partial<ReadMeta>>('read', { path })
  if (typeof m.content !== 'string') throw new Error(`fs read "${path}": response has no content field`)
  return { content: m.content, version: m.version ?? '', encoding: m.encoding ?? 'utf8' }
}

/** Tulis dengan cek konflik: `EVERSION` (+`current`) bila berubah, `ENOENT` bila `mustExist` dan hilang. */
export function writeChecked(path: string, content: string, opts: { expectedVersion?: FsVersion; mustExist?: boolean } = {}): Promise<FsResult> {
  return postJson('write', { path, content, ...opts })
}

/** Buat file baru secara eksklusif: `EEXIST` bila sudah ada (isi lama utuh). */
export function create(path: string, content?: string): Promise<FsResult> {
  return postJson('create', { path, content })
}

/** `mkdir -p` dengan `created` (false = sudah ada). */
export function mkdirChecked(path: string): Promise<FsResult<{ created: boolean }>> {
  return postJson('mkdir', { path })
}

export function stat(path: string): Promise<FsResult<{ meta: FileMeta; version: FsVersion }>> {
  return call('stat', { path })
}

/** Listing berisi size/mtime/kind; `truncated` bila lewat batas server. Beda dengan `list`: ini TIDAK fail-open. */
export function listV2(path: string, limit?: number): Promise<FsResult<ListV2>> {
  return call('list-v2', limit ? { path, limit: String(limit) } : { path })
}

/** Hapus ke trash (default) atau permanen. Flag MUTATE; mati = `EDISABLED`. */
export function remove(path: string, permanent = false): Promise<FsResult<{ trashId?: string }>> {
  return postJson('delete', { path, permanent })
}

export function restore(trashId: string): Promise<FsResult<{ path: string }>> {
  return postJson('restore', { trashId })
}

export function rename(from: string, to: string, overwrite = false): Promise<FsResult> {
  return postJson('rename', { from, to, overwrite })
}

export function copy(from: string, to: string): Promise<FsResult> {
  return postJson('copy', { from, to })
}

export function gitStatus(dir: string): Promise<FsResult<GitStatus>> {
  return call('git-status', { path: dir })
}

export function search(root: string, q: string, limit?: number): Promise<FsResult<{ files: string[]; truncated: boolean }>> {
  return call('search', limit ? { root, q, limit: String(limit) } : { root, q })
}

const CAPS_OFF: FsCapabilities = { mutate: false, viewers: false, watch: false, git: false, quickOpen: false, upload: false, listMax: 0 }

// Cache PROMISE (bukan nilai) supaya slot + ViewerHost yang memanggil serentak berbagi satu request.
// Flag server dibaca saat boot, jadi cache hidup selama halaman hidup; dikosongkan saat WS reconnect
// karena server bisa restart dengan flag lain. Hasil gagal (CAPS_OFF / throw) TIDAK di-cache.
let capsCache: Promise<FsCapabilities> | null = null
onReconnect(() => { capsCache = null })

/** Kosongkan cache `capabilities()` (dipakai tes dan reconnect). */
export function resetCapabilitiesCache(): void {
  capsCache = null
}

async function fetchCapabilities(): Promise<{ caps: FsCapabilities; ok: boolean }> {
  const r = await call<FsCapabilities>('capabilities', {})
  return r.ok
    ? { caps: { mutate: r.mutate, viewers: r.viewers, watch: r.watch, git: r.git, quickOpen: r.quickOpen, upload: r.upload, listMax: r.listMax }, ok: true }
    : { caps: CAPS_OFF, ok: false }
}

/** Kemampuan server (di-cache bersama). FAIL-CLOSED: gagal = semua fitur opsional mati, bukan menebak hidup. */
export function capabilities(): Promise<FsCapabilities> {
  if (capsCache) return capsCache
  const p: Promise<FsCapabilities> = fetchCapabilities().then(
    ({ caps, ok }) => {
      if (!ok && capsCache === p) capsCache = null
      return caps
    },
    (err: unknown) => {
      if (capsCache === p) capsCache = null
      throw err
    },
  )
  capsCache = p
  return p
}

/** URL `raw` (gambar/audio/video/PDF/download) dengan token yang sama dengan verb lain. */
export function rawUrl(path: string): string {
  return url('raw', { path })
}

/** Upload satu file ke `dir/name` (stream body mentah). `EEXIST`/`ETOOLARGE` lewat `FsFail`. */
export function upload(dir: string, name: string, file: Blob): Promise<FsResult<object>> {
  return call('upload', { dir, name }, { method: 'POST', body: file })
}
