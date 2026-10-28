// Diadaptasi dari nodeterm `src/renderer/lib/filesNode.test.ts` — bagian interaksi keyboard; sisi
// semantik path/listing ada di `./filesNode.test.ts`.
import { describe, expect, it } from 'vitest'
import { listKeyAction, scrollTopToReveal, TYPEAHEAD_RESET_MS, typeAhead, typeAheadIndex } from './filesKeys'

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

describe('listKeyAction', () => {
  it('moves the selection with the arrows, clamping at both ends', () => {
    expect(listKeyAction({ key: 'ArrowDown' }, -1, 3)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'ArrowDown' }, 1, 3)).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction({ key: 'ArrowDown' }, 2, 3)).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction({ key: 'ArrowUp' }, -1, 3)).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction({ key: 'ArrowUp' }, 0, 3)).toEqual({ kind: 'select', index: 0 })
  })

  it('jumps to the ends with Home and End', () => {
    expect(listKeyAction({ key: 'Home' }, 2, 3)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction({ key: 'End' }, 0, 3)).toEqual({ kind: 'select', index: 2 })
  })

  it('opens the selection with Enter and Cmd+ArrowDown', () => {
    expect(listKeyAction({ key: 'Enter' }, 1, 3)).toEqual({ kind: 'open', index: 1 })
    expect(listKeyAction({ key: 'ArrowDown', meta: true }, 1, 3)).toEqual({ kind: 'open', index: 1 })
  })

  it('does not open when nothing is selected', () => {
    expect(listKeyAction({ key: 'Enter' }, -1, 3)).toBeNull()
    expect(listKeyAction({ key: 'ArrowDown', meta: true }, -1, 3)).toBeNull()
  })

  // Chord Windows dan Finder dua-duanya naik: tangan pengguna meraih yang ia hafal.
  it('goes up on Backspace, Alt+ArrowUp and Cmd+ArrowUp', () => {
    expect(listKeyAction({ key: 'Backspace' }, 0, 3)).toEqual({ kind: 'up' })
    expect(listKeyAction({ key: 'ArrowUp', alt: true }, 0, 3)).toEqual({ kind: 'up' })
    expect(listKeyAction({ key: 'ArrowUp', meta: true }, 0, 3)).toEqual({ kind: 'up' })
  })

  // Naik tetap jalan di listing kosong — di situlah pengguna justru paling butuh keluar.
  it('still goes up from an empty listing', () => {
    expect(listKeyAction({ key: 'Backspace' }, -1, 0)).toEqual({ kind: 'up' })
    expect(listKeyAction({ key: 'ArrowDown' }, -1, 0)).toBeNull()
  })

  it('releases keys that are not listing navigation', () => {
    expect(listKeyAction({ key: 'a' }, 0, 3)).toBeNull()
    expect(listKeyAction({ key: 'Tab' }, 0, 3)).toBeNull()
    // Ctrl dan modifier lain milik shortcut lain (atau browser) — jangan dibajak.
    expect(listKeyAction({ key: 'ArrowDown', ctrl: true }, 0, 3)).toBeNull()
    expect(listKeyAction({ key: 'Home', alt: true }, 2, 3)).toBeNull()
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
