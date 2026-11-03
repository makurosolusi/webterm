// Satu sumber jenis file untuk server (sniff, Content-Type) dan klien (viewer, ikon). Menyerap
// tabel ekstensi `src/client/editorFile.ts` TANPA mengubahnya — WS-FM-02 yang menyambungkannya.
import { SNIFF_BYTES } from './fsLimits'

export type FileKind = 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'markdown' | 'archive' | 'binary'

/** Ekstensi -> Content-Type untuk jenis yang bisa disajikan lewat `raw`. Tak ada di sini = octet-stream. */
const MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
}

const EXTS: Readonly<Record<'markdown' | 'archive' | 'binary', ReadonlySet<string>>> = {
  markdown: new Set('md markdown mdown mkd'.split(' ')),
  archive: new Set('zip tar gz tgz bz2 xz 7z rar zst'.split(' ')),
  binary: new Set('exe dll so dylib bin wasm class o a iso dmg woff woff2 ttf otf eot sqlite sqlite3 db'.split(' ')),
}

/** Ekstensi lowercase tanpa titik; '' bila tidak ada (`.gitignore` -> '', bukan 'gitignore'). */
function extOf(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Content-Type dari ekstensi, atau undefined bila tidak disajikan inline. */
export function mimeOf(name: string): string | undefined {
  return MIME[extOf(name)]
}

/** True bila `bytes` (hanya `SNIFF_BYTES` pertama diperiksa) memuat NUL, tanda file biner. */
export function sniffBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0)
}

/** Decode UTF-8 ketat; `null` bila ada byte tak sah. BOM dipertahankan (`ignoreBOM`) agar tulis-balik utuh. */
export function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null // byte bukan UTF-8 sah: itu jawaban (non-utf8), bukan error
  }
}

/**
 * Jenis file dari nama; `sniff` (awal isi file) hanya menentukan untuk ekstensi yang tak dikenal:
 * teks yang berisi NUL jadi `binary`.
 */
export function fileKind(name: string, sniff?: Uint8Array): FileKind {
  const ext = extOf(name)
  const mime = MIME[ext]
  if (mime) return mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'pdf'
  for (const k of ['markdown', 'archive', 'binary'] as const) if (EXTS[k].has(ext)) return k
  return sniff && sniffBinary(sniff) ? 'binary' : 'text'
}
