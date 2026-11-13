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

/** 'text' dibuka di Monaco; sisanya diserahkan ke `ViewerHost` (image/pdf/audio/video, placeholder
 *  untuk archive/binary). */
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
 * Whether a newly opened node starts in the rendered preview. Like the Preview/Edit toggle (and
 * VS Code's "Open Preview"), it applies to Markdown files only.
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

const slashed = (p: string): string => p.replace(/\\/g, '/')

/** Path induk (tanpa slash akhir); '' bila `path` tak punya induk. */
export function dirName(path: string): string {
  const p = slashed(path)
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : i === 0 && p.length > 1 ? '/' : ''
}

/** True bila `path` adalah `root` itu sendiri atau berada di bawahnya (rename/hapus folder ikut file di dalamnya). */
export function isUnder(path: string, root: string): boolean {
  const p = slashed(path)
  const r = slashed(root).replace(/\/+$/, '')
  return p === r || p.startsWith(`${r}/`)
}

/** Path baru `path` setelah `from` di-rename jadi `to`, atau null bila `path` tak terdampak. */
export function remapPath(path: string, from: string, to: string): string | null {
  if (!isUnder(path, from)) return null
  return to.replace(/\/+$/, '') + slashed(path).slice(slashed(from).replace(/\/+$/, '').length)
}
