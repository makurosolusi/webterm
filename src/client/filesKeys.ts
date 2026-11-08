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
  /** Open a file: pinned, or `preview` (reuses the preview editor; focus stays in the tree). */
  | { kind: 'open'; index: number; preview?: true }
  /** Expand/collapse the folder row `index`. */
  | { kind: 'toggle'; index: number }
  | { kind: 'up' }
  | { kind: 'selectAll' }
  | { kind: 'rename' }
  | { kind: 'delete'; permanent: boolean }
  | { kind: 'menu' }
  | { kind: 'copyPath'; relative: boolean }
  | { kind: 'reveal' }
  /** Claimed but does nothing (Backspace, Left on a top-level row): it must not reach the canvas. */
  | { kind: 'none' }
  | null

export interface ListKeyEvent {
  key: string
  /** `KeyboardEvent.code`: dipakai ⌥⌘C/⌥⌘R karena `key` di macOS menjadi "ç" saat Alt ditekan. */
  code?: string
  alt?: boolean
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
}

/** What the keys need to know about a visible tree row (a `TreeRow` fits). */
export interface KeyRow { entry: { dir: boolean }; open: boolean; depth: number }

/** Index of the nearest row above `i` that is shallower (its parent folder); -1 at top level. */
function parentIndex(rows: readonly KeyRow[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (rows[j].depth < rows[i].depth) return j
  return -1
}

/**
 * What a key does in the tree (VS Code Explorer model). `current` is the cursor index (-1 = none),
 * `rows` the visible rows and `page` rows per PageUp/PageDown. Up/Down move; Right expands a folder
 * or steps to its first child; Left collapses or jumps to the parent; Enter opens a file pinned or
 * toggles a folder; Space opens keeping focus in the tree; ⌘↑/Alt+↑ go to the parent FOLDER of
 * the node (the breadcrumb does the same). Backspace alone is claimed and does nothing.
 * `Delete`/`F2`/⌘⌫ are only reported (the mutate slot acts on them first); they stay claimed so
 * they never delete the canvas NODE. `null` = not a tree key; the caller releases it.
 */
export function listKeyAction(
  e: ListKeyEvent,
  current: number,
  rows: readonly KeyRow[],
  page = DEFAULT_PAGE_ROWS
): ListKeyAction {
  const count = rows.length
  const cmd = e.meta || e.ctrl
  const row = current >= 0 ? rows[current] : undefined
  if (cmd && !e.alt && e.key.toLowerCase() === 'a') return count > 0 ? { kind: 'selectAll' } : null
  if (cmd && e.alt && e.code === 'KeyC') return { kind: 'copyPath', relative: !!e.shift }
  if (cmd && e.alt && !e.shift && e.code === 'KeyR') return { kind: 'reveal' }
  if (cmd && e.key === 'Backspace') return { kind: 'delete', permanent: !!e.alt }
  if (e.ctrl) return null
  if (e.key === 'ContextMenu' || (e.shift && e.key === 'F10')) return { kind: 'menu' }
  if (e.key === 'ArrowUp' && (e.alt || e.meta)) return { kind: 'up' }
  if (e.key === 'ArrowDown' && e.meta) return row ? activate(row, current, false) : null
  if (e.alt || e.meta) return null
  if (e.key === 'Backspace') return { kind: 'none' }
  if (e.key === 'Enter') return row ? activate(row, current, false) : null
  if (e.key === ' ') return row ? activate(row, current, true) : null
  if (e.key === 'F2') return { kind: 'rename' }
  if (e.key === 'Delete') return { kind: 'delete', permanent: !!e.shift }
  if (count === 0) return e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? { kind: 'none' } : null
  const last = count - 1
  const at = (index: number): ListKeyAction => {
    const clamped = Math.max(0, Math.min(index, last))
    return e.shift ? { kind: 'select', index: clamped, extend: true } : { kind: 'select', index: clamped }
  }
  switch (e.key) {
    case 'ArrowRight':
      if (!row || !row.entry.dir) return { kind: 'none' }
      if (!row.open) return { kind: 'toggle', index: current }
      return (rows[current + 1]?.depth ?? -1) > row.depth ? at(current + 1) : { kind: 'none' }
    case 'ArrowLeft': {
      if (!row) return { kind: 'none' }
      if (row.entry.dir && row.open) return { kind: 'toggle', index: current }
      const parent = parentIndex(rows, current)
      return parent >= 0 ? at(parent) : { kind: 'none' }
    }
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

/** Enter/Space/⌘↓ on a row: a folder toggles, a file opens (Space = preview, focus stays). */
function activate(row: KeyRow, index: number, space: boolean): ListKeyAction {
  if (row.entry.dir) return { kind: 'toggle', index }
  return space ? { kind: 'open', index, preview: true } : { kind: 'open', index }
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
