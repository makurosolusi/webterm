// inputHistory: normalization on load, push (dedupe, most recent first, cap), strict PATCH check, and
// the entry-patch semantics shared with projectModels.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { applySettingsPatch, isEntryKey } from './settings.patch'
import {
  INPUT_HISTORY_LIMITS, inputHistoryPatchErrors, normalizeHistoryList, normalizeInputHistory, pushHistory,
} from './settings.inputHistory'

const long = 'x'.repeat(INPUT_HISTORY_LIMITS.valueLength + 1) // test-only

describe('inputHistory', () => {
  it('defaults to empty and is an entry patch key', () => {
    expect(DEFAULT_SETTINGS.inputHistory).toEqual({})
    expect(isEntryKey('inputHistory')).toBe(true)
    const doc = applySettingsPatch({ inputHistory: { a: ['1'], b: ['2'] } }, { inputHistory: { a: null, c: ['3'] } })
    expect(doc.inputHistory).toEqual({ b: ['2'], c: ['3'] })
  })

  it('push: trimmed, deduped, most recent first, capped; an invalid value changes nothing', () => {
    expect(pushHistory(['b', 'a'], '  a ')).toEqual(['a', 'b'])
    const full = Array.from({ length: INPUT_HISTORY_LIMITS.values }, (_, i) => `v${i}`)
    const next = pushHistory(full, 'new')
    expect(next).toHaveLength(INPUT_HISTORY_LIMITS.values)
    expect(next[0]).toBe('new')
    expect(next).not.toContain(`v${INPUT_HISTORY_LIMITS.values - 1}`)
    expect(pushHistory(['a'], '   ')).toEqual(['a'])
    expect(pushHistory(['a'], long)).toEqual(['a'])
  })

  it('load: junk dropped, lists normalized, at most 50 fields (oldest created go)', () => {
    expect(normalizeHistoryList([' a ', 'a', 3, '', long, 'b'])).toEqual(['a', 'b'])
    expect(normalizeInputHistory({ 'bad id!': ['a'], ok: ['x'], empty: [], notList: 'x' })).toEqual({ ok: ['x'] })
    const many = Object.fromEntries(Array.from({ length: INPUT_HISTORY_LIMITS.fields + 5 }, (_, i) => [`f${i}`, ['v']]))
    const out = normalizeInputHistory(many)
    expect(Object.keys(out)).toHaveLength(INPUT_HISTORY_LIMITS.fields)
    expect(out.f0).toBeUndefined()
    expect(out[`f${INPUT_HISTORY_LIMITS.fields + 4}`]).toEqual(['v'])
    expect(mergeSettings({ inputHistory: { ok: ['x', 'x'] } }).inputHistory).toEqual({ ok: ['x'] })
    expect(mergeSettings({ inputHistory: ['x'] }).inputHistory).toEqual({})
  })

  it('patch check: only stored-form lists or null pass; errors never carry the value', () => {
    expect(inputHistoryPatchErrors(undefined)).toEqual([])
    expect(inputHistoryPatchErrors({ 'terminal.fontFamily': ['Menlo'], gone: null })).toEqual([])
    expect(inputHistoryPatchErrors([])).toEqual([{ index: -1, field: 'inputHistory', code: 'not_object' }])
    expect(inputHistoryPatchErrors({ 'no spaces': ['a'] })).toEqual([{ index: 0, field: 'inputHistory.id', code: 'invalid_id' }])
    for (const bad of [[' padded '], ['a', 'a'], [], [long], ['a', 1], 'a', Array.from({ length: 11 }, (_, i) => `${i}`)]) {
      expect(inputHistoryPatchErrors({ f: bad })).toEqual([{ index: 0, field: 'inputHistory.list', code: 'invalid_list' }])
    }
    const tooMany = Object.fromEntries(Array.from({ length: INPUT_HISTORY_LIMITS.fields + 1 }, (_, i) => [`f${i}`, null]))
    expect(inputHistoryPatchErrors(tooMany)[0]?.code).toBe('too_many_fields')
  })
})
