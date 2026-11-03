// Pilihan TAMPILAN node files yang murni (tanpa DOM): sembunyikan dotfile, urutan, path relatif,
// dan pembeda 401. Dipisah dari `fileBrowse.ts` (semantik path) yang sudah di batas ukuran.
import type { FsFail } from '../shared/fsContract'
import type { ViewOpts } from '../shared/workspace'

/** Default saat `viewOpts` absen (P-9/P-15): dotfile tampil, nama naik. */
export const DEFAULT_VIEW: ViewOpts = { hidden: false, sortKey: 'name', sortDir: 'asc' }

/** `hidden: true` = dotfile DISEMBUNYIKAN. Absen/false = tampil seperti sebelum ada toggle. */
export const viewOf = (v: ViewOpts | undefined): ViewOpts => v ?? DEFAULT_VIEW

/** Urutan selain nama butuh `size`/`mtimeMs` dari `list-v2`; urutan nama cukup dari `list`. */
export const needsMeta = (v: ViewOpts): boolean => v.sortKey !== 'name'

// Natural-numeric ("file2" < "file10") sama dengan sort server; dipakai hanya saat dibalik.
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

interface Sortable { name: string; dir: boolean; size?: number; mtimeMs?: number }

/**
 * Terapkan opsi tampilan. Folder SELALU di atas file. Nama-naik mempertahankan urutan server
 * (sudah natural, folder dulu) — tidak diurut ulang supaya dua sumber urutan tak bisa berselisih.
 */
export function applyView<T extends Sortable>(entries: readonly T[], v: ViewOpts): T[] {
  const list = v.hidden ? entries.filter((e) => !e.name.startsWith('.')) : [...entries]
  if (v.sortKey === 'name' && v.sortDir === 'asc') return list
  const sign = v.sortDir === 'asc' ? 1 : -1
  const byName = (a: T, b: T) => NATURAL.compare(a.name, b.name)
  return list.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    if (v.sortKey === 'name') return sign * byName(a, b)
    // Folder tak punya ukuran berarti: tetap urut nama agar stabil.
    if (a.dir && v.sortKey === 'size') return byName(a, b)
    const key = v.sortKey === 'size' ? 'size' : 'mtimeMs'
    return sign * ((a[key] ?? 0) - (b[key] ?? 0)) || byName(a, b)
  })
}

/** Path `target` relatif terhadap `root`; di luar `root` = path absolut apa adanya. */
export function relativePath(root: string, target: string): string {
  const base = root.replace(/\/+$/, '')
  if (target === base) return '.'
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target
}

/**
 * Kegagalan karena token ditolak (401), bukan folder yang tak terjangkau. `fsClient.call` mengubah
 * body non-FsFail (halaman error auth) jadi `EIO` dengan "HTTP <status>" di pesannya — itu satu-
 * satunya jejak status yang tersisa di sisi klien, jadi dicocokkan di sini.
 */
export function isAuthFail(r: Pick<FsFail, 'code' | 'error'>): boolean {
  return r.code === 'EIO' && /\bHTTP 401\b/.test(r.error)
}
