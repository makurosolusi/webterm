// Seleksi baris FilesNode disimpan per NAMA (NFC), bukan indeks: indeks bergeser tiap daftar
// dimuat ulang/diurut ulang, sedangkan nama stabil. NFC karena macOS (HFS+/sebagian API) bisa
// mengembalikan nama NFD untuk string yang sama (M-12 / R-13).
//
// Model multi-select: `names` (himpunan terpilih), `anchor` (ujung tetap rentang Shift) dan
// `cursor` (baris fokus/aktif — satu-satunya "fokus" yang dilihat pengguna; DOM focus tetap di list).
import type { DirEntry } from './fileBrowse'

/** Bentuk kanonik (NFC) sebuah nama entri untuk dibandingkan. */
export const nfcName = (name: string): string => name.normalize('NFC')

/** Indeks entri yang namanya (NFC) sama dengan `selName`; -1 bila tak ada atau `selName` null. */
export function indexOfName(entries: readonly DirEntry[], selName: string | null): number {
  if (selName === null) return -1
  return entries.findIndex((e) => nfcName(e.name) === selName)
}

export interface Sel {
  names: ReadonlySet<string>
  anchor: string | null
  cursor: string | null
}

export const EMPTY_SEL: Sel = { names: new Set(), anchor: null, cursor: null }

/** Pilih tepat satu nama (klik biasa / panah tanpa Shift). */
export function selectOne(name: string | null): Sel {
  if (name === null) return EMPTY_SEL
  const n = nfcName(name)
  return { names: new Set([n]), anchor: n, cursor: n }
}

/** ⌘/Ctrl-klik: balikkan keanggotaan satu nama; anchor dan kursor pindah ke sana. */
export function toggleName(sel: Sel, name: string): Sel {
  const n = nfcName(name)
  const names = new Set(sel.names)
  if (!names.delete(n)) names.add(n)
  return { names, anchor: n, cursor: n }
}

/** Shift-klik/Shift+panah: rentang anchor..indeks `to`; tanpa anchor jatuh ke pilihan tunggal. */
export function selectRange(sel: Sel, shown: readonly DirEntry[], to: number): Sel {
  const target = shown[to]
  if (!target) return sel
  const from = sel.anchor === null ? -1 : indexOfName(shown, sel.anchor)
  if (from < 0) return selectOne(target.name)
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return {
    names: new Set(shown.slice(lo, hi + 1).map((e) => nfcName(e.name))),
    anchor: sel.anchor,
    cursor: nfcName(target.name),
  }
}

/** ⌘A: semua baris yang tampil; kursor dipertahankan bila masih ada, kalau tidak baris pertama. */
export function selectAll(sel: Sel, shown: readonly DirEntry[]): Sel {
  if (shown.length === 0) return sel
  const names = new Set(shown.map((e) => nfcName(e.name)))
  const cursor = sel.cursor !== null && names.has(sel.cursor) ? sel.cursor : nfcName(shown[0].name)
  return { names, anchor: nfcName(shown[0].name), cursor }
}

/** Nama asli entri tampil yang terpilih, dalam urutan tampil. */
export function selectedNames(shown: readonly DirEntry[], sel: Sel): string[] {
  return shown.filter((e) => sel.names.has(nfcName(e.name))).map((e) => e.name)
}
