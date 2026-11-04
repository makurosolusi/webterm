import { describe, expect, it } from 'vitest'
import { DIFF_NOTE_BODY_MAX, DIFF_NOTES_MAX, validDiffNotes } from './workspace'

describe('validDiffNotes', () => {
  const ok = { id: 'n1', path: 'src/a.ts', line: 3, body: 'why?' }
  it('keeps well-formed notes and strips unknown fields', () => {
    expect(validDiffNotes([{ ...ok, extra: 1 }])).toEqual([ok])
    expect(validDiffNotes([{ ...ok, line: 0 }])).toEqual([{ ...ok, line: 0 }])
  })
  it('drops malformed entries and non-arrays', () => {
    expect(validDiffNotes(undefined)).toEqual([])
    expect(validDiffNotes({ 0: ok })).toEqual([])
    expect(validDiffNotes([
      null, 'x', { ...ok, line: -1 }, { ...ok, line: 1.5 }, { ...ok, body: '' }, { ...ok, path: 7 },
      { ...ok, body: 'x'.repeat(DIFF_NOTE_BODY_MAX + 1) },
    ])).toEqual([])
  })
  it('caps the list length', () => {
    expect(validDiffNotes(Array.from({ length: DIFF_NOTES_MAX + 5 }, (_, i) => ({ ...ok, id: `n${i}` })))).toHaveLength(DIFF_NOTES_MAX)
  })
})
