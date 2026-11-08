import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { normalizeProjectModel, normalizeProjectModels, projectModelsPatchErrors, PROJECT_MODELS_LIMITS } from './settings.projectModels'

describe('projectModels schema', () => {
  it('defaults to no overrides (absent = ladder)', () => {
    expect(DEFAULT_SETTINGS.projectModels).toEqual({})
    expect(mergeSettings({}).projectModels).toEqual({})
  })

  it('keeps valid model/effort and drops unknown fields or values', () => {
    expect(normalizeProjectModel({ model: 'fable', effort: 'xhigh' })).toEqual({ model: 'fable', effort: 'xhigh' })
    expect(normalizeProjectModel({ effort: 'medium' })).toEqual({ effort: 'medium' })
    expect(normalizeProjectModel({ model: 'gpt-4', effort: 'low', extra: 1 })).toEqual({ effort: 'low' })
    expect(normalizeProjectModel({ model: 'Opus' })).toBeNull() // exact alias only
    expect(normalizeProjectModel({})).toBeNull()
    expect(normalizeProjectModel('opus')).toBeNull()
  })

  it('normalizes the map: bad ids and empty entries go, the size is bounded', () => {
    expect(normalizeProjectModels({ ws1: { model: 'opus' }, ws2: { model: 'x' }, '': { model: 'haiku' } })).toEqual({ ws1: { model: 'opus' } })
    expect(normalizeProjectModels([{ model: 'opus' }])).toEqual({})
    const big = Object.fromEntries(Array.from({ length: PROJECT_MODELS_LIMITS.entries + 5 }, (_, i) => [`w${i}`, { model: 'haiku' }]))
    expect(Object.keys(normalizeProjectModels(big))).toHaveLength(PROJECT_MODELS_LIMITS.entries)
    expect(mergeSettings({ projectModels: { w: { model: 'sonnet', effort: 'nope' } } }).projectModels).toEqual({ w: { model: 'sonnet' } })
  })

  it('strict patch check: null deletes, anything not exactly valid is an error', () => {
    expect(projectModelsPatchErrors(undefined)).toEqual([])
    expect(projectModelsPatchErrors({ a: null, b: { model: 'opus', effort: 'max' } })).toEqual([])
    expect(projectModelsPatchErrors({ a: { model: 'opus', extra: true } })).toEqual([{ index: 0, field: 'projectModels.entry', code: 'invalid_override' }])
    expect(projectModelsPatchErrors({ a: { model: 'opus' }, b: 'haiku' })).toEqual([{ index: 1, field: 'projectModels.entry', code: 'invalid_override' }])
    expect(projectModelsPatchErrors([1])).toEqual([{ index: -1, field: 'projectModels', code: 'not_object' }])
    expect(projectModelsPatchErrors({ ['x'.repeat(PROJECT_MODELS_LIMITS.idLength + 1)]: null })[0]?.code).toBe('invalid_id')
  })
})
