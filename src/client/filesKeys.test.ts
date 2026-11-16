// Keyboard half of the files node; path and listing semantics are covered in `./fileBrowse.test.ts`.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_ROWS,
  listKeyAction,
  scrollTopToReveal,
  TYPEAHEAD_RESET_MS,
  typeAhead,
  typeAheadIndex,
  type KeyRow,
} from './filesKeys'

describe('typeAheadIndex', () => {
  const names = ['alpha', 'alps.txt', 'alpine', 'zeta']

  it('selects the first prefix match when nothing is selected', () => {
    expect(typeAheadIndex(names, -1, 'a')).toBe(0)
    expect(typeAheadIndex(names, -1, 'alps')).toBe(1)
    expect(typeAheadIndex(names, -1, 'z')).toBe(3)
  })

  it('cycles through same-letter entries, wrapping around, when a letter repeats', () => {
    expect(typeAheadIndex(names, 0, 'a')).toBe(1)
    expect(typeAheadIndex(names, 1, 'aa')).toBe(2)
    expect(typeAheadIndex(names, 2, 'aaa')).toBe(0)
  })

  it('keeps the current entry while a longer word still matches it', () => {
    expect(typeAheadIndex(names, 2, 'alpi')).toBe(2)
    expect(typeAheadIndex(names, 2, 'alp')).toBe(2)
  })

  it('moves forward when the longer word no longer matches the current entry', () => {
    expect(typeAheadIndex(names, 0, 'alpi')).toBe(2)
  })

  it('answers -1 for no match, an empty buffer or no entries', () => {
    expect(typeAheadIndex(names, -1, 'q')).toBe(-1)
    expect(typeAheadIndex(names, 1, '')).toBe(-1)
    expect(typeAheadIndex([], -1, 'a')).toBe(-1)
  })

  it('ignores case on both the typed text and the names', () => {
    expect(typeAheadIndex(['Readme', 'src'], -1, 'r')).toBe(0)
    expect(typeAheadIndex(['readme', 'src'], -1, 'R')).toBe(0)
    expect(typeAheadIndex(['readme', 'src'], -1, 'SR')).toBe(1)
  })
})

describe('typeAhead', () => {
  const names = ['docs', 'dist', 'lib']

  it('appends to the word while keys arrive inside the window', () => {
    const first = typeAhead({ buffer: '', at: 0 }, 'd', 500, names, -1)
    const second = typeAhead(first.state, 'i', 500 + TYPEAHEAD_RESET_MS, names, first.index)
    expect(second.state).toEqual({ buffer: 'di', at: 500 + TYPEAHEAD_RESET_MS })
    expect(second.index).toBe(1)
  })

  it('starts a fresh word once the pause exceeds the window', () => {
    const next = typeAhead({ buffer: 'di', at: 0 }, 'l', TYPEAHEAD_RESET_MS + 1, names, 1)
    expect(next.state.buffer).toBe('l')
    expect(next.index).toBe(2)
  })
})

const files = (n: number): KeyRow[] => Array.from({ length: n }, () => ({ entry: { dir: false }, open: false, depth: 0 }))
const folder = (depth: number, open: boolean): KeyRow => ({ entry: { dir: true }, open, depth })
const leaf = (depth: number): KeyRow => ({ entry: { dir: false }, open: false, depth })

describe('listKeyAction: movement', () => {
  it('steps with the arrows and stops at both ends', () => {
    const rows = files(4)
    expect(listKeyAction({ key: 'ArrowDown' }, -1, rows)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowDown' }, 2, rows)).toEqual({ kind: 'select', index: 3 })
    expect(listKeyAction({ key: 'ArrowDown' }, 3, rows)).toEqual({ kind: 'select', index: 3 })
    expect(listKeyAction({ key: 'ArrowUp' }, -1, rows)).toEqual({ kind: 'select', index: 3 })
    expect(listKeyAction({ key: 'ArrowUp' }, 0, rows)).toEqual({ kind: 'select', index: 0 })
  })

  it('jumps to the first and last row with Home and End', () => {
    expect(listKeyAction({ key: 'Home' }, 3, files(5))).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'End' }, 1, files(5))).toEqual({ kind: 'select', index: 4 })
  })

  it('moves a page at a time and clamps, using the default page size when none is given', () => {
    const rows = files(40)
    expect(listKeyAction({ key: 'PageDown' }, 5, rows, 8)).toEqual({ kind: 'select', index: 13 })
    expect(listKeyAction({ key: 'PageDown' }, 35, rows, 8)).toEqual({ kind: 'select', index: 39 })
    expect(listKeyAction({ key: 'PageUp' }, 3, rows, 8)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'PageDown' }, -1, rows, 8)).toEqual({ kind: 'select', index: 8 })
    expect(listKeyAction({ key: 'PageDown' }, 0, rows)).toEqual({ kind: 'select', index: DEFAULT_PAGE_ROWS })
    expect(listKeyAction({ key: 'PageDown' }, 0, rows, 0)).toEqual({ kind: 'select', index: 1 })
  })

  it('extends the selection when Shift is held', () => {
    const rows = files(6)
    expect(listKeyAction({ key: 'ArrowDown', shift: true }, 1, rows)).toEqual({ kind: 'select', index: 2, extend: true })
    expect(listKeyAction({ key: 'End', shift: true }, 1, rows)).toEqual({ kind: 'select', index: 5, extend: true })
    expect(listKeyAction({ key: 'ArrowUp', shift: true }, 0, rows)).toEqual({ kind: 'select', index: 0, extend: true })
  })

  it('releases keys that are not tree keys, and chords owned by something else', () => {
    const rows = files(3)
    for (const key of ['x', 'Tab', 'Escape']) expect(listKeyAction({ key }, 0, rows)).toBeNull()
    expect(listKeyAction({ key: 'ArrowDown', ctrl: true }, 0, rows)).toBeNull()
    expect(listKeyAction({ key: 'Home', alt: true }, 1, rows)).toBeNull()
    expect(listKeyAction({ key: 'ArrowDown' }, -1, [])).toBeNull()
  })
})

describe('listKeyAction: folders', () => {
  // docs/ (open) > [img/ (closed), a.md], b.md
  const rows = [folder(0, true), folder(1, false), leaf(1), leaf(0)]

  it('Right opens a closed folder, enters an open one and does nothing on a file', () => {
    expect(listKeyAction({ key: 'ArrowRight' }, 1, rows)).toEqual({ kind: 'toggle', index: 1 })
    expect(listKeyAction({ key: 'ArrowRight' }, 0, rows)).toEqual({ kind: 'select', index: 1 })
    expect(listKeyAction({ key: 'ArrowRight' }, 2, rows)).toEqual({ kind: 'none' })
    expect(listKeyAction({ key: 'ArrowRight' }, 0, [folder(0, true), leaf(0)])).toEqual({ kind: 'none' })
    expect(listKeyAction({ key: 'ArrowRight' }, 0, [])).toEqual({ kind: 'none' })
  })

  it('Left closes an open folder, else goes to the parent; top-level rows stay put', () => {
    expect(listKeyAction({ key: 'ArrowLeft' }, 0, rows)).toEqual({ kind: 'toggle', index: 0 })
    expect(listKeyAction({ key: 'ArrowLeft' }, 1, rows)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowLeft' }, 2, rows)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowLeft' }, 3, rows)).toEqual({ kind: 'none' })
    expect(listKeyAction({ key: 'ArrowLeft' }, -1, [])).toEqual({ kind: 'none' })
  })

  it('Enter and Cmd+Down open a file and toggle a folder; Space opens without taking focus', () => {
    expect(listKeyAction({ key: 'Enter' }, 2, rows)).toEqual({ kind: 'open', index: 2 })
    expect(listKeyAction({ key: 'ArrowDown', meta: true }, 2, rows)).toEqual({ kind: 'open', index: 2 })
    expect(listKeyAction({ key: 'Enter' }, 1, rows)).toEqual({ kind: 'toggle', index: 1 })
    expect(listKeyAction({ key: ' ' }, 2, rows)).toEqual({ kind: 'open', index: 2, keepFocus: true })
    expect(listKeyAction({ key: ' ' }, 0, rows)).toEqual({ kind: 'toggle', index: 0 })
  })

  it('does not activate anything without a cursor', () => {
    for (const e of [{ key: 'Enter' }, { key: ' ' }, { key: 'ArrowDown', meta: true }]) {
      expect(listKeyAction(e, -1, rows)).toBeNull()
    }
  })
})

describe('listKeyAction: file operations', () => {
  const rows = files(3)

  it('goes to the parent folder on Alt+Up or Cmd+Up, even from an empty listing', () => {
    expect(listKeyAction({ key: 'ArrowUp', alt: true }, 1, rows)).toEqual({ kind: 'up' })
    expect(listKeyAction({ key: 'ArrowUp', meta: true }, -1, [])).toEqual({ kind: 'up' })
  })

  it('claims a bare Backspace without acting on it', () => {
    expect(listKeyAction({ key: 'Backspace' }, 1, rows)).toEqual({ kind: 'none' })
  })

  it('reports rename and delete without reaching the canvas, even with no rows', () => {
    expect(listKeyAction({ key: 'F2' }, 0, rows)).toEqual({ kind: 'rename' })
    expect(listKeyAction({ key: 'Delete' }, 0, rows)).toEqual({ kind: 'delete', permanent: false })
    expect(listKeyAction({ key: 'Delete', shift: true }, 0, rows)).toEqual({ kind: 'delete', permanent: true })
    expect(listKeyAction({ key: 'Delete' }, -1, [])).toEqual({ kind: 'delete', permanent: false })
    expect(listKeyAction({ key: 'Backspace', meta: true }, 0, rows)).toEqual({ kind: 'delete', permanent: false })
    expect(listKeyAction({ key: 'Backspace', meta: true, alt: true }, 0, rows)).toEqual({ kind: 'delete', permanent: true })
  })

  it('selects all on Cmd/Ctrl+A only when there are rows', () => {
    expect(listKeyAction({ key: 'a', meta: true }, 0, rows)).toEqual({ kind: 'selectAll' })
    expect(listKeyAction({ key: 'A', ctrl: true }, 0, rows)).toEqual({ kind: 'selectAll' })
    expect(listKeyAction({ key: 'a', meta: true }, -1, [])).toBeNull()
  })

  it('opens the context menu from the keyboard', () => {
    expect(listKeyAction({ key: 'ContextMenu' }, 0, rows)).toEqual({ kind: 'menu' })
    expect(listKeyAction({ key: 'F10', shift: true }, 0, rows)).toEqual({ kind: 'menu' })
    expect(listKeyAction({ key: 'F10' }, 0, rows)).toBeNull()
  })

  it('copies the path on Alt+Cmd+C (Shift = relative), matched by code because Alt rewrites key', () => {
    expect(listKeyAction({ key: 'ç', code: 'KeyC', alt: true, meta: true }, 0, rows)).toEqual({ kind: 'copyPath', relative: false })
    expect(listKeyAction({ key: 'Ç', code: 'KeyC', alt: true, meta: true, shift: true }, 0, rows)).toEqual({ kind: 'copyPath', relative: true })
  })

  it('reveals on Alt+Cmd+R only: not with Shift, not without Alt', () => {
    expect(listKeyAction({ key: '®', code: 'KeyR', alt: true, meta: true }, 0, rows)).toEqual({ kind: 'reveal' })
    expect(listKeyAction({ key: 'R', code: 'KeyR', alt: true, meta: true, shift: true }, 0, rows)).toBeNull()
    expect(listKeyAction({ key: 'r', code: 'KeyR', meta: true }, 0, rows)).toBeNull()
  })
})

describe('scrollTopToReveal', () => {
  // A 200px viewport scrolled to 100 shows y in [100, 300); rows are 20px tall.
  it('scrolls up so a row above the viewport lands at the top edge', () => {
    expect(scrollTopToReveal(60, 20, 100, 200)).toBe(60)
  })

  it('scrolls down just far enough to show a row below the viewport', () => {
    expect(scrollTopToReveal(400, 20, 100, 200)).toBe(220)
  })

  it('does not move for a row that is fully visible, including at both edges', () => {
    expect(scrollTopToReveal(100, 20, 100, 200)).toBe(100)
    expect(scrollTopToReveal(280, 20, 100, 200)).toBe(100)
    expect(scrollTopToReveal(180, 20, 100, 200)).toBe(100)
  })
})
