// Validasi dan penamaan SATU segmen nama entri (rename, duplikat). Hanya UX: server memvalidasi
// ulang (NUL, '/', '..', <=255 byte) — lihat PLAN/FILEMANAGER-b.md, bagian Path & traversal.
// Murni, tanpa DOM; `newEntryPath` (./fileBrowse) tetap untuk nama bersarang pada "New File".

/** Batas byte satu segmen nama pada filesystem umum (ext4/APFS). */
export const MAX_NAME_BYTES = 255

export type NameProblem = 'empty' | 'reserved' | 'slash' | 'nul' | 'long'
export type NameCheck = { ok: true; name: string } | { ok: false; problem: NameProblem }

/** Periksa satu nama segmen; `name` hasil di-trim. `/` ditolak (rename tak boleh memindah folder). */
export function checkName(raw: string): NameCheck {
  const name = raw.trim()
  if (!name) return { ok: false, problem: 'empty' }
  if (name === '.' || name === '..') return { ok: false, problem: 'reserved' }
  if (name.includes('\0')) return { ok: false, problem: 'nul' }
  if (name.includes('/') || name.includes('\\')) return { ok: false, problem: 'slash' }
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return { ok: false, problem: 'long' }
  return { ok: true, name }
}

/** Indeks awal ekstensi (titik terakhir yang bukan awal nama), atau panjang nama bila tak ada. */
export function stemEnd(name: string): number {
  const i = name.lastIndexOf('.')
  return i > 0 ? i : name.length
}

const canon = (s: string): string => s.normalize('NFC').toLowerCase()
/** Akhiran " copy" / " copy N" yang dibuat duplikat sebelumnya, supaya duplikat-dari-duplikat tidak menumpuk. */
const COPY_SUFFIX = / copy(?: \d+)?$/

/**
 * Nama bebas untuk duplikat `name`: "a copy.txt", lalu "a copy 2.txt", dst. Perbandingan NFC dan
 * tak peka huruf besar (APFS bawaan macOS peka-ulang) terhadap `taken`.
 */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(canon))
  const end = stemEnd(name)
  const stem = name.slice(0, end).replace(COPY_SUFFIX, '')
  const ext = name.slice(end)
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`
    if (!used.has(canon(candidate))) return candidate
  }
}
