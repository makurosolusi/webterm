// Enam method filesystem lewat `/api/fs/*` (server: `src/server/fsApi.ts`). Di nodeterm ini
// `window.api.fs.*` di atas IPC Electron; di sini fetch same-origin.
//
// Token dikirim lewat query `?token=` memakai `tokenQuery()` yang sudah diekspor `./api`, BUKAN
// header: header akan menuntut menyentuh `./api` (di luar kepemilikan), dan `authorize()` di
// `src/server/auth.ts` menerima kedua jalur untuk seluruh `/api/*`.
//
// FAIL-OPEN, sama seperti sisi server (lihat kontrak di kepala `src/server/fsOps.ts`): request yang
// gagal — jaringan mati, 4xx, JSON rusak — menjawab nilai kosong yang sama dengan "tidak ada di
// sana", karena `classifyEmptyListing` di `./filesNode` dirancang untuk MEMBEDAKAN keduanya dengan
// bertanya ke direktori induk, bukan dari error. Tiap catch mengembalikan nilai yang
// didokumentasikan, bukan `catch {}` kosong.
import { tokenQuery } from './api'
import type { DirEntry } from './filesNode'

function url(verb: string, params?: Record<string, string>): string {
  const q = new URLSearchParams(params)
  const token = tokenQuery()
  return `/api/fs/${verb}${q.size || token ? '?' : ''}${[q.toString(), token].filter(Boolean).join('&')}`
}

async function get<T>(verb: string, params: Record<string, string>, fallback: T): Promise<T> {
  try {
    const res = await fetch(url(verb, params))
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

async function post(verb: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url(verb), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return false
    const json = (await res.json()) as { ok?: boolean }
    return json.ok === true
  } catch {
    return false
  }
}

/** Isi direktori: folder dulu lalu file, `.git` disembunyikan, entry gitignored ditandai. `[]`
 *  bila direktori tidak ada ATAU memang kosong — `classifyEmptyListing` yang membedakannya. */
export function list(path: string): Promise<DirEntry[]> {
  return get<DirEntry[]>('list', { path }, [])
}

/** Isi UTF-8 sebuah file. `''` bila gagal; sentinel `tooLargeSentinel` bila lewat cap — pemanggil
 *  memeriksanya dengan `tooLargeSize()` dari `src/shared/fsLimits.ts`. */
export async function read(path: string): Promise<string> {
  return (await get<{ content?: string }>('read', { path }, {})).content ?? ''
}

/** Isi file sebagai base64 (gambar/biner). `''` bila gagal, sentinel bila lewat cap biner. */
export async function readBinary(path: string): Promise<string> {
  return (await get<{ base64?: string }>('read-binary', { path }, {})).base64 ?? ''
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
