import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { SKILL_CABLE_COLORS, SKILL_CABLE_SIZES, SKILL_CABLE_WIDTH_PX } from './settings.skillCable'
import { WORKSPACE_HUES } from './workspaceColor'

describe('skill cable color and size settings', () => {
  it('defaults keep today\'s look: accent color, normal (1.5px, the stylesheet width)', () => {
    expect(DEFAULT_SETTINGS.skillCableColor).toBe('default')
    expect(DEFAULT_SETTINGS.skillCableSize).toBe('normal')
    expect(SKILL_CABLE_WIDTH_PX.normal).toBe(1.5)
    expect(mergeSettings({})).toMatchObject({ skillCableColor: 'default', skillCableSize: 'normal' })
  })

  it('offers default plus the 12 palette hues, and four sizes in increasing width', () => {
    expect(SKILL_CABLE_COLORS).toEqual(['default', ...WORKSPACE_HUES])
    const widths = SKILL_CABLE_SIZES.map((s) => SKILL_CABLE_WIDTH_PX[s])
    expect([...widths].sort((a, b) => a - b)).toEqual(widths)
    expect(widths).toHaveLength(4)
  })

  it('keeps a known hue and size', () => {
    expect(mergeSettings({ skillCableColor: 'teal', skillCableSize: 'xthick' })).toMatchObject({ skillCableColor: 'teal', skillCableSize: 'xthick' })
  })

  it('unknown or wrong-shaped values (hex, px, number) fall back to the defaults', () => {
    for (const bad of ['#3b82f6', 'Teal', 'var(--x)', '', 7, null]) expect(mergeSettings({ skillCableColor: bad }).skillCableColor).toBe('default')
    for (const bad of ['huge', '3px', 'Thin', '', 3, null]) expect(mergeSettings({ skillCableSize: bad }).skillCableSize).toBe('normal')
  })
})
