import { tooLargeSize, formatBytes } from '../shared/fsLimits'
import { fileKind } from '../shared/fileKind'

/**
 * Keputusan murni milik node editor: tampilan apa untuk path ini, apakah ia dibuka langsung di
 * preview markdown, dan apakah payload yang balik dari `read`/`readBinary` boleh dibuka sama
 * sekali. Dipisah dari `EditorNode.tsx` supaya bisa dites di node-env — mengimpor komponennya
 * akan menarik Monaco, yang tidak bisa dimuat di luar build Vite.
 *
 * Port dari nodeterm `src/renderer/lib/localFilePreview.ts` + `markdownPreview.ts`.
 */

/** Ekstensi gambar yang dapat preview visual, bukan editor teks Monaco. */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/** 'text' dibuka di Monaco, 'image'/'pdf' punya preview; sisanya (audio, video, archive, binary)
 *  tidak punya penampil di editor dan jatuh ke placeholder jujur. */
export type EditorFileKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'archive' | 'binary'

/** Ekstensi lowercase tanpa titik; '' kalau tidak ada (`.gitignore` → '', bukan 'gitignore'). */
export function fileExt(path: string): string {
  const name = fileBaseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Nama file terakhir dari path; backslash ikut dihitung sebagai pemisah. */
export function fileBaseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || ''
}

/** Jenis tampilan node editor untuk path ini; jenis dari `fileKind()` (satu sumber dgn server). */
export function editorFileKind(path: string): EditorFileKind {
  const k = fileKind(path)
  return k === 'markdown' ? 'text' : k
}

/** Ekstensi yang dianggap markdown untuk keputusan auto-preview. */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])

export function isMarkdownExt(ext: string): boolean {
  return MARKDOWN_EXTS.has(ext.toLowerCase())
}

/**
 * Apakah node yang baru dibuka langsung tampil sebagai preview terender.
 * Sengaja lebih sempit daripada toggle Preview/Edit (yang jalan di file teks apa pun): auto-preview
 * hanya untuk file yang memang markdown — membuka .ts sebagai render markdown adalah default yang
 * membingungkan untuk setting bernama `openMarkdownPreview`.
 */
export function opensInPreview(ext: string, openMarkdownPreview: boolean): boolean {
  return openMarkdownPreview && isMarkdownExt(ext)
}

/**
 * Pesan penolakan untuk payload yang balik dari `read`/`readBinary`, atau null kalau boleh dibuka.
 *
 * INI SOAL KEHILANGAN DATA, bukan performa. File di atas cap `fsLimits` balik sebagai sentinel
 * too-large, bukan isinya. Kalau node tetap dibuka dengan buffer kosong, satu ⌘S menimpa file asli
 * pengguna dengan nol byte — jadi payload yang ditolak di sini WAJIB membuat node menolak membuka
 * editor, dan `EditorNode` hanya mengizinkan save setelah pemuatan berhasil.
 *
 * `allowEmpty` untuk teks: file kosong itu sah. Untuk gambar/PDF payload kosong selalu kegagalan
 * baca. Perhatikan `read` TIDAK bisa membedakan "file kosong" dari "gagal baca" (keduanya ''),
 * jadi gerbang save di komponen-lah yang menutup sisa celahnya.
 */
export function loadRefusal(payload: string, label: string, allowEmpty = false): string | null {
  const tooBig = tooLargeSize(payload)
  if (tooBig != null) return `${label} too large to open here (${formatBytes(tooBig)}).`
  if (!payload && !allowEmpty) return `Couldn’t read this ${label.toLowerCase()}.`
  return null
}

/**
 * Byte file dari base64, atau null kalau base64-nya tidak bisa didekode (pemanggil melaporkan
 * kegagalan baca alih-alih membingkai dokumen kosong).
 *
 * `charCodeAt` per byte, BUKAN `TextEncoder`: PDF itu biner, dan mengenkode ulang sebagai UTF-8
 * akan menulis ulang setiap byte di atas 0x7f menjadi rangkaian multi-byte dan merusak dokumennya.
 *
 * Generic `<ArrayBuffer>` eksplisit: `BlobPart` menolak Uint8Array ber-backing `ArrayBufferLike`
 * (yang bisa SharedArrayBuffer), sementara pemanggilnya membungkus hasil ini jadi Blob.
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  let bin: string
  try {
    bin = atob(b64)
  } catch {
    // Satu-satunya kegagalan yang mungkin di sini adalah base64 cacat, dan pemanggil hanya butuh
    // tahu "tidak bisa didekode" — isi payload-nya sendiri tidak boleh ikut dilaporkan ke mana pun.
    return null
  }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
