// Seleksi baris FilesNode disimpan per NAMA (NFC), bukan indeks: indeks bergeser tiap daftar
// dimuat ulang/diurut ulang, sedangkan nama stabil. NFC karena macOS (HFS+/sebagian API) bisa
// mengembalikan nama NFD untuk string yang sama (M-12 / R-13).
import type { DirEntry } from './fileBrowse'

/** Bentuk kanonik (NFC) sebuah nama entri untuk dibandingkan. */
export const nfcName = (name: string): string => name.normalize('NFC')

/** Indeks entri yang namanya (NFC) sama dengan `selName`; -1 bila tak ada atau `selName` null. */
export function indexOfName(entries: readonly DirEntry[], selName: string | null): number {
  if (selName === null) return -1
  return entries.findIndex((e) => nfcName(e.name) === selName)
}
