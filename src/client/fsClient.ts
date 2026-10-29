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
import { tokenQuery } from './api'
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

/** Isi UTF-8 sebuah file. MELEMPAR bila gagal baca — `''` berarti file itu memang kosong. Sentinel
 *  `tooLargeSentinel` bila lewat cap: itu sukses, pemanggil memeriksanya dengan `tooLargeSize()`
 *  dari `src/shared/fsLimits.ts`. */
export async function read(path: string): Promise<string> {
  const { content } = await getStrict<{ content?: string }>('read', { path })
  // Field hilang = respons bukan jawaban read yang sah. Dibiarkan jadi '' akan menghidupkan lagi
  // persis bug buffer-kosong-yang-bisa-disimpan yang kontrak ini tutup.
  if (typeof content !== 'string') throw new Error(`fs read "${path}": respons tanpa field content`)
  return content
}

/** Isi file sebagai base64 (gambar/biner). MELEMPAR bila gagal baca, sentinel bila lewat cap biner. */
export async function readBinary(path: string): Promise<string> {
  const { base64 } = await getStrict<{ base64?: string }>('read-binary', { path })
  if (typeof base64 !== 'string') throw new Error(`fs read-binary "${path}": respons tanpa field base64`)
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
