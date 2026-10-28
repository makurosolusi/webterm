/**
 * Interaksi KEYBOARD untuk listing node files: type-ahead, aksi tombol navigasi, dan scroll
 * minimal yang menampakkan baris terpilih. Dipisahkan dari `./filesNode.ts` — yang itu soal
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

export type ListKeyAction =
  | { kind: 'select'; index: number }
  | { kind: 'open'; index: number }
  | { kind: 'up' }
  | null

/**
 * Apa yang dilakukan tombol navigasi di listing. `current` adalah indeks terpilih (-1 bila tidak
 * ada) dan `count` jumlah entry yang ditampilkan. Chord Windows maupun Finder keduanya bekerja,
 * karena tangan pengguna meraih yang ia hafal: Enter / ⌘↓ membuka, Backspace / Alt+↑ / ⌘↑ naik.
 * `null` = bukan tombol listing; pemanggil melepaskannya.
 */
export function listKeyAction(
  e: { key: string; alt?: boolean; meta?: boolean; ctrl?: boolean },
  current: number,
  count: number
): ListKeyAction {
  if (e.ctrl) return null
  if (e.key === 'ArrowUp' && (e.alt || e.meta)) return { kind: 'up' }
  if (e.key === 'ArrowDown' && e.meta) return current >= 0 ? { kind: 'open', index: current } : null
  if (e.alt || e.meta) return null
  if (e.key === 'Backspace') return { kind: 'up' }
  if (e.key === 'Enter') return current >= 0 ? { kind: 'open', index: current } : null
  if (count === 0) return null
  const last = count - 1
  switch (e.key) {
    case 'ArrowDown':
      return { kind: 'select', index: current < 0 ? 0 : Math.min(current + 1, last) }
    case 'ArrowUp':
      return { kind: 'select', index: current < 0 ? last : Math.max(current - 1, 0) }
    case 'Home':
      return { kind: 'select', index: 0 }
    case 'End':
      return { kind: 'select', index: last }
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
