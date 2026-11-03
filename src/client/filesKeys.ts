/**
 * Interaksi KEYBOARD untuk listing node files: type-ahead, aksi tombol navigasi, dan scroll
 * minimal yang menampakkan baris terpilih. Dipisahkan dari `./fileBrowse.ts` — yang itu soal
 * SEMANTIK path dan listing, ini soal apa yang dilakukan tangan pengguna; keduanya tidak saling
 * bergantung, dan satu file berisi keduanya melewati batas ukuran.
 *
 * Murni dan tanpa DOM (vitest webterm berjalan di node-env). Diport dari nodeterm
 * `src/renderer/lib/filesNode.ts`.
 */

/** Berapa lama jeda mengakhiri satu kata type-ahead. Mengetik "bu" di dalam jendela ini mencari
 *  "bu…"; setelahnya, tombol berikutnya mulai dari awal. */
export const TYPEAHEAD_RESET_MS = 1000

/**
 * Type-ahead gaya Windows Explorer: indeks entry yang dipilih `buffer`, atau -1 bila tidak ada.
 *
 *  - Satu huruf — atau huruf sama yang diulang ("b", "bb") — MEMUTAR: entry berikutnya setelah
 *    `current` yang berawalan huruf itu, melingkar. Begitu cara menekan B tiga kali menyusuri B.
 *  - Sebuah kata ("bui") adalah pencarian prefix dari `current` INKLUSIF, jadi memperpanjang kata
 *    yang masih cocok dengan entry terpilih mempertahankannya alih-alih melompat melewatinya.
 *
 * Case-insensitive; `current` bernilai -1 saat tidak ada yang terpilih.
 */
export function typeAheadIndex(names: readonly string[], current: number, buffer: string): number {
  if (!buffer || names.length === 0) return -1
  const q = buffer.toLowerCase()
  const cycling = [...q].every((c) => c === q[0])
  const needle = cycling ? q[0] : q
  const start = cycling ? current + 1 : Math.max(current, 0)
  for (let i = 0; i < names.length; i++) {
    const idx = (start + i + names.length) % names.length
    if (names[idx].toLowerCase().startsWith(needle)) return idx
  }
  return -1
}

export interface TypeAheadState {
  buffer: string
  /** Kapan tombol terakhir ditekan (ms). */
  at: number
}

/** Lipat satu tombol yang ditekan ke dalam kata type-ahead dan resolve apa yang ia pilih. */
export function typeAhead(
  state: TypeAheadState,
  key: string,
  now: number,
  names: readonly string[],
  current: number
): { state: TypeAheadState; index: number } {
  const buffer = (now - state.at > TYPEAHEAD_RESET_MS ? '' : state.buffer) + key
  return { state: { buffer, at: now }, index: typeAheadIndex(names, current, buffer) }
}

/** Baris per "halaman" bila tinggi list belum terukur (jsdom/layout 0). */
export const DEFAULT_PAGE_ROWS = 10

export type ListKeyAction =
  | { kind: 'select'; index: number; extend?: true }
  | { kind: 'open'; index: number; dirOnly?: true }
  | { kind: 'up' }
  | { kind: 'selectAll' }
  | { kind: 'rename' }
  | { kind: 'delete'; permanent: boolean }
  | { kind: 'menu' }
  | { kind: 'copyPath'; relative: boolean }
  | null

export interface ListKeyEvent {
  key: string
  /** `KeyboardEvent.code`: dipakai ⌥⌘C karena `key` di macOS menjadi "ç" saat Alt ditekan. */
  code?: string
  alt?: boolean
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
}

/**
 * Apa yang dilakukan tombol navigasi di listing. `current` adalah indeks kursor (-1 bila tidak
 * ada), `count` jumlah entry yang ditampilkan dan `page` baris per PageUp/PageDown. Chord Windows
 * maupun Finder keduanya bekerja, karena tangan pengguna meraih yang ia hafal: Enter / ⌘↓ membuka,
 * Backspace / ← / Alt+↑ / ⌘↑ naik, → membuka FOLDER. `Delete`/`F2` hanya dilaporkan (aksi nyatanya
 * milik slot mutate); tetap diklaim supaya Delete tak ikut menghapus node. `null` = bukan tombol
 * listing; pemanggil melepaskannya.
 */
export function listKeyAction(
  e: ListKeyEvent,
  current: number,
  count: number,
  page = DEFAULT_PAGE_ROWS
): ListKeyAction {
  const cmd = e.meta || e.ctrl
  if (cmd && !e.alt && e.key.toLowerCase() === 'a') return count > 0 ? { kind: 'selectAll' } : null
  if (cmd && e.alt && e.code === 'KeyC') return { kind: 'copyPath', relative: !!e.shift }
  if (e.ctrl) return null
  if (e.key === 'ContextMenu' || (e.shift && e.key === 'F10')) return { kind: 'menu' }
  if (e.key === 'ArrowUp' && (e.alt || e.meta)) return { kind: 'up' }
  if (e.key === 'ArrowDown' && e.meta) return current >= 0 ? { kind: 'open', index: current } : null
  if (e.alt || e.meta) return null
  if (e.key === 'Backspace' || e.key === 'ArrowLeft') return { kind: 'up' }
  if (e.key === 'ArrowRight') return current >= 0 ? { kind: 'open', index: current, dirOnly: true } : null
  if (e.key === 'Enter') return current >= 0 ? { kind: 'open', index: current } : null
  if (e.key === 'F2') return { kind: 'rename' }
  if (e.key === 'Delete') return { kind: 'delete', permanent: !!e.shift }
  if (count === 0) return null
  const last = count - 1
  const at = (index: number): ListKeyAction => {
    const clamped = Math.max(0, Math.min(index, last))
    return e.shift ? { kind: 'select', index: clamped, extend: true } : { kind: 'select', index: clamped }
  }
  switch (e.key) {
    case 'ArrowDown':
      return at(current < 0 ? 0 : current + 1)
    case 'ArrowUp':
      return at(current < 0 ? last : current - 1)
    case 'PageDown':
      return at(Math.max(current, 0) + Math.max(1, page))
    case 'PageUp':
      return at(Math.max(current, 0) - Math.max(1, page))
    case 'Home':
      return at(0)
    case 'End':
      return at(last)
    default:
      return null
  }
}

/**
 * `scrollTop` yang membawa satu baris sepenuhnya ke dalam pandangan, bergerak sesedikit mungkin
 * (aturan `block: 'nearest'`). Dihitung tangan alih-alih dengan `scrollIntoView`, yang juga
 * men-scroll setiap ANCESTOR yang bisa di-scroll — di dalam canvas itu termasuk kontainer
 * `overflow: hidden` milik React Flow, dan ia akan menyeret seluruh pane di bawah viewport yang
 * ter-transform. Semua nilai adalah piksel layout, jadi zoom canvas tidak relevan.
 */
export function scrollTopToReveal(
  rowTop: number,
  rowHeight: number,
  scrollTop: number,
  viewHeight: number
): number {
  if (rowTop < scrollTop) return rowTop
  if (rowTop + rowHeight > scrollTop + viewHeight) return rowTop + rowHeight - viewHeight
  return scrollTop
}
