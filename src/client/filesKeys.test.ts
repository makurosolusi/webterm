// Bagian interaksi keyboard; sisi
// semantik path/listing ada di `./fileBrowse.test.ts`.
import { describe, expect, it } from 'vitest'
import { listKeyAction, scrollTopToReveal, TYPEAHEAD_RESET_MS, typeAhead, typeAheadIndex, type KeyRow } from './filesKeys'

describe('typeAheadIndex', () => {
  const names = ['build', 'bun.lock', 'bundle', 'src']

  it('finds the first prefix match from nothing selected', () => {
    expect(typeAheadIndex(names, -1, 'b')).toBe(0)
    expect(typeAheadIndex(names, -1, 'bun')).toBe(1)
  })

  // Menekan satu huruf berulang MEMUTAR entri yang berawalan huruf itu — gestur Explorer/Finder.
  it('cycles through same-letter matches on a repeated letter', () => {
    expect(typeAheadIndex(names, 0, 'b')).toBe(1)
    expect(typeAheadIndex(names, 1, 'bb')).toBe(2)
    expect(typeAheadIndex(names, 2, 'b')).toBe(0)
  })

  // Pencarian kata INKLUSIF terhadap `current`: memperpanjang kata yang masih cocok dengan entry
  // terpilih mempertahankannya alih-alih melompat ke kecocokan berikutnya.
  it('keeps the selection when a word search still matches it', () => {
    expect(typeAheadIndex(names, 2, 'bund')).toBe(2)
  })

  it('answers -1 for no match, an empty buffer or an empty list', () => {
    expect(typeAheadIndex(names, -1, 'zz')).toBe(-1)
    expect(typeAheadIndex(names, 0, '')).toBe(-1)
    expect(typeAheadIndex([], -1, 'b')).toBe(-1)
  })

  it('is case-insensitive in both directions', () => {
    expect(typeAheadIndex(['Build', 'src'], -1, 'b')).toBe(0)
    expect(typeAheadIndex(['build', 'src'], -1, 'B')).toBe(0)
  })
})

describe('typeAhead', () => {
  const names = ['build', 'bun.lock', 'src']

  it('extends the buffer within the reset window', () => {
    const first = typeAhead({ buffer: '', at: 0 }, 'b', 1000, names, -1)
    expect(first.state.buffer).toBe('b')
    const second = typeAhead(first.state, 'u', 1200, names, first.index)
    expect(second.state.buffer).toBe('bu')
    expect(second.index).toBe(0)
  })

  it('starts a new word after the reset window', () => {
    const stale = { buffer: 'bui', at: 1000 }
    const next = typeAhead(stale, 's', 1000 + TYPEAHEAD_RESET_MS + 1, names, 0)
    expect(next.state.buffer).toBe('s')
    expect(next.index).toBe(2)
  })
})

/** n flat file rows at depth 0. */
const flat = (n: number): KeyRow[] => Array.from({ length: n }, () => ({ entry: { dir: false }, open: false, depth: 0 }))
const dir = (depth: number, open: boolean): KeyRow => ({ entry: { dir: true }, open, depth })
const file = (depth: number): KeyRow => ({ entry: { dir: false }, open: false, depth })

describe('listKeyAction', () => {
  it('moves the selection with the arrows, clamping at both ends', () => {
    expect(listKeyAction({ key: 'ArrowDown' }, -1, flat(3))).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowDown' }, 1, flat(3))).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction({ key: 'ArrowDown' }, 2, flat(3))).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction({ key: 'ArrowUp' }, -1, flat(3))).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction({ key: 'ArrowUp' }, 0, flat(3))).toEqual({ kind: 'select', index: 0 })
  })

  it('jumps to the ends with Home and End', () => {
    expect(listKeyAction({ key: 'Home' }, 2, flat(3))).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'End' }, 0, flat(3))).toEqual({ kind: 'select', index: 2 })
  })

  it('opens the selection with Enter and Cmd+ArrowDown', () => {
    expect(listKeyAction({ key: 'Enter' }, 1, flat(3))).toEqual({ kind: 'open', index: 1 })
    expect(listKeyAction({ key: 'ArrowDown', meta: true }, 1, flat(3))).toEqual({ kind: 'open', index: 1 })
  })

  it('does not open when nothing is selected', () => {
    expect(listKeyAction({ key: 'Enter' }, -1, flat(3))).toBeNull()
    expect(listKeyAction({ key: 'ArrowDown', meta: true }, -1, flat(3))).toBeNull()
  })

  // Finder chords go to the parent folder; Backspace alone no longer does (the breadcrumb does).
  it('goes up on Alt+ArrowUp and Cmd+ArrowUp; Backspace alone is claimed but inert', () => {
    expect(listKeyAction({ key: 'Backspace' }, 0, flat(3))).toEqual({ kind: 'none' })
    expect(listKeyAction({ key: 'ArrowUp', alt: true }, 0, flat(3))).toEqual({ kind: 'up' })
    expect(listKeyAction({ key: 'ArrowUp', meta: true }, 0, flat(3))).toEqual({ kind: 'up' })
  })

  // Naik tetap jalan di listing kosong — di situlah pengguna justru paling butuh keluar.
  it('still goes up from an empty listing', () => {
    expect(listKeyAction({ key: 'ArrowUp', meta: true }, -1, flat(0))).toEqual({ kind: 'up' })
    expect(listKeyAction({ key: 'ArrowDown' }, -1, flat(0))).toBeNull()
  })

  it('releases keys that are not listing navigation', () => {
    expect(listKeyAction({ key: 'a' }, 0, flat(3))).toBeNull()
    expect(listKeyAction({ key: 'Tab' }, 0, flat(3))).toBeNull()
    // Ctrl dan modifier lain milik shortcut lain (atau browser) — jangan dibajak.
    expect(listKeyAction({ key: 'ArrowDown', ctrl: true }, 0, flat(3))).toBeNull()
    expect(listKeyAction({ key: 'Home', alt: true }, 2, flat(3))).toBeNull()
  })
})

describe('scrollTopToReveal', () => {
  it('scrolls up to a row above the viewport', () => {
    expect(scrollTopToReveal(40, 20, 100, 200)).toBe(40)
  })

  it('scrolls down the minimum to show a row below the viewport', () => {
    expect(scrollTopToReveal(500, 20, 100, 200)).toBe(320)
  })

  it('leaves a fully visible row alone', () => {
    expect(scrollTopToReveal(120, 20, 100, 200)).toBe(100)
    expect(scrollTopToReveal(280, 20, 100, 200)).toBe(100)
  })
})

describe('listKeyAction — fase 2', () => {
  it('Delete dan F2 dilaporkan (Shift+Delete = permanen), bukan dilepas ke canvas', () => {
    expect(listKeyAction({ key: 'Delete' }, 0, flat(3))).toEqual({ kind: 'delete', permanent: false })
    expect(listKeyAction({ key: 'Delete', shift: true }, 0, flat(3))).toEqual({ kind: 'delete', permanent: true })
    expect(listKeyAction({ key: 'F2' }, 0, flat(3))).toEqual({ kind: 'rename' })
    // Tanpa baris pun Delete tetap diklaim: node tidak boleh terhapus.
    expect(listKeyAction({ key: 'Delete' }, -1, flat(0))).toEqual({ kind: 'delete', permanent: false })
  })

  it('PageUp/PageDown melompat satu halaman dan terjepit di ujung', () => {
    expect(listKeyAction({ key: 'PageDown' }, 2, flat(50), 10)).toEqual({ kind: 'select', index: 12 })
    expect(listKeyAction({ key: 'PageDown' }, 45, flat(50), 10)).toEqual({ kind: 'select', index: 49 })
    expect(listKeyAction({ key: 'PageUp' }, 4, flat(50), 10)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'PageDown' }, -1, flat(50), 10)).toEqual({ kind: 'select', index: 10 })
  })

  it('Home/End dan Shift+panah memperluas seleksi', () => {
    expect(listKeyAction({ key: 'Home' }, 5, flat(9))).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'End', shift: true }, 5, flat(9))).toEqual({ kind: 'select', index: 8, extend: true })
    expect(listKeyAction({ key: 'ArrowDown', shift: true }, 2, flat(9))).toEqual({ kind: 'select', index: 3, extend: true })
    expect(listKeyAction({ key: 'ArrowUp', shift: true }, 0, flat(9))).toEqual({ kind: 'select', index: 0, extend: true })
  })

  it('⌘A / Ctrl+A memilih semua hanya bila ada baris', () => {
    expect(listKeyAction({ key: 'a', meta: true }, 0, flat(3))).toEqual({ kind: 'selectAll' })
    expect(listKeyAction({ key: 'A', ctrl: true }, 0, flat(3))).toEqual({ kind: 'selectAll' })
    expect(listKeyAction({ key: 'a', meta: true }, -1, flat(0))).toBeNull()
  })

  it('ContextMenu dan Shift+F10 membuka menu', () => {
    expect(listKeyAction({ key: 'ContextMenu' }, 0, flat(3))).toEqual({ kind: 'menu' })
    expect(listKeyAction({ key: 'F10', shift: true }, 0, flat(3))).toEqual({ kind: 'menu' })
    expect(listKeyAction({ key: 'F10' }, 0, flat(3))).toBeNull()
  })

  it('⌥⌘C menyalin path, dengan Shift path relatif (pakai code, bukan key)', () => {
    expect(listKeyAction({ key: 'ç', code: 'KeyC', alt: true, meta: true }, 0, flat(3))).toEqual({ kind: 'copyPath', relative: false })
    expect(listKeyAction({ key: 'Ç', code: 'KeyC', alt: true, meta: true, shift: true }, 0, flat(3))).toEqual({ kind: 'copyPath', relative: true })
  })

  it('⌥⌘R reveals in the OS file manager (by code); Shift or no Alt is not reveal', () => {
    expect(listKeyAction({ key: '®', code: 'KeyR', alt: true, meta: true }, 0, flat(3))).toEqual({ kind: 'reveal' })
    expect(listKeyAction({ key: 'R', code: 'KeyR', alt: true, meta: true, shift: true }, 0, flat(3))).toBeNull()
    expect(listKeyAction({ key: 'r', code: 'KeyR', meta: true }, 0, flat(3))).toBeNull()
  })
})

describe('listKeyAction: tree keys', () => {
  // src/ (open) > [lib/ (closed), a.ts], b.ts
  const tree = [dir(0, true), dir(1, false), file(1), file(0)]

  it('Right expands a closed folder, steps into an open one, and is inert on files', () => {
    expect(listKeyAction({ key: 'ArrowRight' }, 1, tree)).toEqual({ kind: 'toggle', index: 1 })
    expect(listKeyAction({ key: 'ArrowRight' }, 0, tree)).toEqual({ kind: 'select', index: 1 })
    expect(listKeyAction({ key: 'ArrowRight' }, 2, tree)).toEqual({ kind: 'none' })
    // An open folder with no loaded children stays put.
    expect(listKeyAction({ key: 'ArrowRight' }, 0, [dir(0, true), file(0)])).toEqual({ kind: 'none' })
  })

  it('Left collapses an open folder, otherwise jumps to the parent; top level is inert', () => {
    expect(listKeyAction({ key: 'ArrowLeft' }, 0, tree)).toEqual({ kind: 'toggle', index: 0 })
    expect(listKeyAction({ key: 'ArrowLeft' }, 2, tree)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowLeft' }, 1, tree)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowLeft' }, 3, tree)).toEqual({ kind: 'none' })
    expect(listKeyAction({ key: 'ArrowLeft' }, -1, flat(0))).toEqual({ kind: 'none' })
  })

  it('Enter opens a file and toggles a folder; Space opens keeping focus', () => {
    expect(listKeyAction({ key: 'Enter' }, 2, tree)).toEqual({ kind: 'open', index: 2 })
    expect(listKeyAction({ key: 'Enter' }, 1, tree)).toEqual({ kind: 'toggle', index: 1 })
    expect(listKeyAction({ key: ' ' }, 2, tree)).toEqual({ kind: 'open', index: 2, keepFocus: true })
    expect(listKeyAction({ key: ' ' }, 0, tree)).toEqual({ kind: 'toggle', index: 0 })
  })

  it('Cmd+Backspace / Delete trash; Cmd+Alt+Backspace / Shift+Delete are permanent', () => {
    expect(listKeyAction({ key: 'Backspace', meta: true }, 0, tree)).toEqual({ kind: 'delete', permanent: false })
    expect(listKeyAction({ key: 'Backspace', meta: true, alt: true }, 0, tree)).toEqual({ kind: 'delete', permanent: true })
    expect(listKeyAction({ key: 'Delete' }, 0, tree)).toEqual({ kind: 'delete', permanent: false })
    expect(listKeyAction({ key: 'Delete', shift: true }, 0, tree)).toEqual({ kind: 'delete', permanent: true })
  })
})
