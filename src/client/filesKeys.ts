/**
 * Keyboard interaction for the files-node listing: type-ahead, the key -> action map and the
 * minimal scroll that reveals the selected row. Separate from `./fileBrowse.ts`, which is about path
 * and listing semantics; the two do not depend on each other.
 *
 * Pure and DOM-free (the test runner is node-env). The tree keys follow the WAI-ARIA Authoring
 * Practices "Tree View" pattern (https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): Up/Down move,
 * Right opens a closed folder or steps to its first child, Left closes an open folder or steps to
 * the parent, Home/End jump to the ends, Enter activates; type-ahead is the pattern's "type-ahead"
 * option. Extras for a file manager (rename, delete, copy path, reveal) sit on the usual desktop chords.
 */

/** Pause (ms) that ends a type-ahead word: typing "bu" inside the window searches "bu…", later keys start over. */
export const TYPEAHEAD_RESET_MS = 1000

/**
 * Index of the entry that `buffer` selects, or -1 for none.
 *
 *  - One letter, or the same letter repeated ("b", "bb"), CYCLES: the next entry after `current`
 *    starting with that letter, wrapping around.
 *  - A longer word ("bui") is a prefix search starting AT `current`, so extending a word that still
 *    matches the selected entry keeps it instead of jumping past it.
 *
 * Case-insensitive; `current` is -1 when nothing is selected.
 */
export function typeAheadIndex(names: readonly string[], current: number, buffer: string): number {
  if (!buffer || names.length === 0) return -1
  const typed = buffer.toLowerCase()
  const repeatedLetter = typed.split('').every((ch) => ch === typed[0])
  const prefix = repeatedLetter ? typed[0] : typed
  const firstCandidate = repeatedLetter ? current + 1 : Math.max(current, 0)
  const total = names.length
  for (let step = 0; step < total; step++) {
    const index = (firstCandidate + step + total) % total
    if (names[index].toLowerCase().startsWith(prefix)) return index
  }
  return -1
}

export interface TypeAheadState {
  buffer: string
  /** When the last key was pressed (ms). */
  at: number
}

/** Fold one pressed key into the type-ahead word and resolve what it selects. */
export function typeAhead(
  state: TypeAheadState,
  key: string,
  now: number,
  names: readonly string[],
  current: number
): { state: TypeAheadState; index: number } {
  const expired = now - state.at > TYPEAHEAD_RESET_MS
  const buffer = (expired ? '' : state.buffer) + key
  return { state: { buffer, at: now }, index: typeAheadIndex(names, current, buffer) }
}

/** Rows per PageUp/PageDown when the list height is not measured yet (jsdom, zero layout). */
export const DEFAULT_PAGE_ROWS = 10

export type ListKeyAction =
  | { kind: 'select'; index: number; extend?: true }
  /** Open a file in its own editor node; `keepFocus` leaves focus and selection in the tree. */
  | { kind: 'open'; index: number; keepFocus?: true }
  /** Expand or collapse the folder row `index`. */
  | { kind: 'toggle'; index: number }
  | { kind: 'up' }
  | { kind: 'selectAll' }
  | { kind: 'rename' }
  | { kind: 'delete'; permanent: boolean }
  | { kind: 'menu' }
  | { kind: 'copyPath'; relative: boolean }
  | { kind: 'reveal' }
  /** Claimed but inert (Backspace, Left on a top-level row): it must not reach the canvas. */
  | { kind: 'none' }
  | null

export interface ListKeyEvent {
  key: string
  /** `KeyboardEvent.code`: used for Alt+Cmd+C / Alt+Cmd+R because macOS turns `key` into "ç" while Alt is down. */
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

/** Enter / Space / Cmd+Down on a row: a folder toggles, a file opens (Space keeps focus in the tree). */
function activate(row: KeyRow, index: number, keepFocus: boolean): ListKeyAction {
  if (row.entry.dir) return { kind: 'toggle', index }
  return keepFocus ? { kind: 'open', index, keepFocus: true } : { kind: 'open', index }
}

/** Chords with Cmd/Ctrl held (select all, copy path, reveal, trash); null when none applies. */
function commandChord(e: ListKeyEvent, rowCount: number): ListKeyAction {
  if (!e.meta && !e.ctrl) return null
  if (e.alt && e.code === 'KeyC') return { kind: 'copyPath', relative: !!e.shift }
  if (e.alt && !e.shift && e.code === 'KeyR') return { kind: 'reveal' }
  if (e.key === 'Backspace') return { kind: 'delete', permanent: !!e.alt }
  if (!e.alt && e.key.toLowerCase() === 'a' && rowCount > 0) return { kind: 'selectAll' }
  return null
}

/** Arrow, Page, Home and End keys over a non-empty list; Shift extends the selection. */
function movement(
  e: ListKeyEvent,
  current: number,
  rows: readonly KeyRow[],
  page: number
): ListKeyAction {
  const last = rows.length - 1
  const row = current >= 0 ? rows[current] : undefined
  const moveTo = (index: number): ListKeyAction => {
    const bounded = Math.max(0, Math.min(index, last))
    return e.shift ? { kind: 'select', index: bounded, extend: true } : { kind: 'select', index: bounded }
  }
  const pageRows = Math.max(1, page)
  switch (e.key) {
    case 'ArrowRight': {
      if (!row || !row.entry.dir) return { kind: 'none' }
      if (!row.open) return { kind: 'toggle', index: current }
      const hasChild = (rows[current + 1]?.depth ?? -1) > row.depth
      return hasChild ? moveTo(current + 1) : { kind: 'none' }
    }
    case 'ArrowLeft': {
      if (!row) return { kind: 'none' }
      if (row.entry.dir && row.open) return { kind: 'toggle', index: current }
      const parent = parentIndex(rows, current)
      return parent >= 0 ? moveTo(parent) : { kind: 'none' }
    }
    case 'ArrowDown':
      return moveTo(current < 0 ? 0 : current + 1)
    case 'ArrowUp':
      return moveTo(current < 0 ? last : current - 1)
    case 'PageDown':
      return moveTo(Math.max(current, 0) + pageRows)
    case 'PageUp':
      return moveTo(Math.max(current, 0) - pageRows)
    case 'Home':
      return moveTo(0)
    case 'End':
      return moveTo(last)
    default:
      return null
  }
}

/**
 * What a key does in the tree. `current` is the cursor index (-1 = none), `rows` the visible rows,
 * `page` the rows per PageUp/PageDown.
 *
 * Cmd/Alt + Up goes to the parent folder of the node (the breadcrumb does the same). Backspace
 * alone is claimed and does nothing. Delete, F2 and Cmd+Backspace are only reported (the mutate
 * slot acts on them first) but stay claimed so they never delete the canvas NODE. `null` means "not
 * a tree key"; the caller releases it.
 */
export function listKeyAction(
  e: ListKeyEvent,
  current: number,
  rows: readonly KeyRow[],
  page = DEFAULT_PAGE_ROWS
): ListKeyAction {
  const chord = commandChord(e, rows.length)
  if (chord) return chord
  if (e.ctrl) return null
  if (e.key === 'ContextMenu' || (e.shift && e.key === 'F10')) return { kind: 'menu' }
  const row = current >= 0 ? rows[current] : undefined
  if (e.key === 'ArrowUp' && (e.alt || e.meta)) return { kind: 'up' }
  if (e.key === 'ArrowDown' && e.meta) return row ? activate(row, current, false) : null
  if (e.alt || e.meta) return null
  switch (e.key) {
    case 'Backspace':
      return { kind: 'none' }
    case 'Enter':
      return row ? activate(row, current, false) : null
    case ' ':
      return row ? activate(row, current, true) : null
    case 'F2':
      return { kind: 'rename' }
    case 'Delete':
      return { kind: 'delete', permanent: !!e.shift }
  }
  if (rows.length === 0) return e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? { kind: 'none' } : null
  return movement(e, current, rows, page)
}

/**
 * The `scrollTop` that brings a row fully into view with the least movement (`block: 'nearest'`).
 * Computed by hand instead of `scrollIntoView`, which also scrolls every scrollable ANCESTOR; on
 * the canvas that includes React Flow's `overflow: hidden` container and drags the whole pane out
 * from under the transformed viewport. All values are layout pixels, so canvas zoom is irrelevant.
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
