import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, SETUP_STEPS } from './settings'
import { applySettingsPatch, mergeSettingsPatches, settingsPatchBefore } from './settings.patch'
import { DEFAULT_SETUP, normalizeSetup } from './settings.setup'

describe('settings.setup normalize', () => {
  it('defaults to incomplete with no steps', () => {
    expect(DEFAULT_SETTINGS.setup).toEqual({ completedAt: null, steps: {} })
    expect(mergeSettings(null).setup).toEqual(DEFAULT_SETUP)
    expect(SETUP_STEPS).toEqual(['claude', 'browser', 'commands', 'central', 'basics'])
  })

  it('drops unknown steps and values', () => {
    expect(normalizeSetup({ completedAt: 5, steps: { claude: 'done', browser: 'skipped', central: 'maybe', bogus: 'done' }, extra: 1 }))
      .toEqual({ completedAt: 5, steps: { claude: 'done', browser: 'skipped' } })
    expect(normalizeSetup({ steps: ['done'] })).toEqual(DEFAULT_SETUP)
    expect(normalizeSetup('nope')).toEqual(DEFAULT_SETUP)
  })

  it('clamps completedAt: negative to 0, fractions truncated, non-numbers null', () => {
    expect(normalizeSetup({ completedAt: -9 }).completedAt).toBe(0)
    expect(normalizeSetup({ completedAt: 12.7 }).completedAt).toBe(12)
    expect(normalizeSetup({ completedAt: Number.POSITIVE_INFINITY }).completedAt).toBeNull()
    expect(normalizeSetup({ completedAt: '123' }).completedAt).toBeNull()
    expect(normalizeSetup({ completedAt: 1e300 }).completedAt).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('mergeSettings runs the stored value through normalize', () => {
    expect(mergeSettings({ setup: { completedAt: 1, steps: { basics: 'done', x: 'done' } } }).setup).toEqual({ completedAt: 1, steps: { basics: 'done' } })
  })
})

describe('settings.setup patch', () => {
  const base = { ...DEFAULT_SETTINGS, setup: { completedAt: null, steps: { claude: 'done' as const } } }

  it('merges one step without dropping the others; null clears a step', () => {
    const next = applySettingsPatch(base, { setup: { steps: { browser: 'skipped' } } })
    expect(next.setup).toEqual({ completedAt: null, steps: { claude: 'done', browser: 'skipped' } })
    expect(applySettingsPatch(next, { setup: { steps: { claude: null } } }).setup.steps).toEqual({ browser: 'skipped' })
  })

  it('completedAt set alone keeps the steps', () => {
    expect(applySettingsPatch(base, { setup: { completedAt: 42 } }).setup).toEqual({ completedAt: 42, steps: { claude: 'done' } })
  })

  it('two pending patches keep both sides\' steps', () => {
    expect(mergeSettingsPatches({ setup: { steps: { claude: 'done' } } }, { setup: { completedAt: 7, steps: { basics: 'skipped' } } }))
      .toEqual({ setup: { completedAt: 7, steps: { claude: 'done', basics: 'skipped' } } })
  })

  it('undo patch restores only the touched steps', () => {
    const before = settingsPatchBefore(base, 'setup', { steps: { browser: 'done', claude: 'skipped' } })
    expect(before).toEqual({ steps: { browser: null, claude: 'done' } })
    const after = applySettingsPatch(base, { setup: { steps: { browser: 'done', claude: 'skipped' } } })
    expect(applySettingsPatch(after, { setup: before as object }).setup).toEqual(base.setup)
  })
})
