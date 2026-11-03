import { describe, it, expect } from 'vitest'
import { shouldDiscard } from './browser.discard'

const base = { loading: false, driven: false, hiddenMs: 300_000, discardMs: 300_000 }

describe('shouldDiscard', () => {
  it('tabel kebenaran: hanya diam + tidak dikemudikan + cukup lama tersembunyi', () => {
    expect(shouldDiscard(base)).toBe(true)
    expect(shouldDiscard({ ...base, hiddenMs: 300_001 })).toBe(true)
    expect(shouldDiscard({ ...base, hiddenMs: 299_999 })).toBe(false)
    expect(shouldDiscard({ ...base, loading: true })).toBe(false)
    expect(shouldDiscard({ ...base, driven: true })).toBe(false)
    expect(shouldDiscard({ ...base, loading: true, driven: true })).toBe(false)
  })

  it('angka non-finite tidak pernah memicu discard', () => {
    expect(shouldDiscard({ ...base, hiddenMs: NaN })).toBe(false)
    expect(shouldDiscard({ ...base, discardMs: NaN })).toBe(false)
  })
})
