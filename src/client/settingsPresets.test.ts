// Preset lists never offer a value the setting's range would clamp away.
import { describe, expect, it } from 'vitest'
import { SETTING_RANGES, type RangedKey } from '../shared/settings.ranges'
import { FONT_WEIGHT_OPTIONS, GRID_SIZE_OPTIONS, NODE_HEIGHT_OPTIONS, NODE_WIDTH_OPTIONS, REPLAY_BUFFER_OPTIONS, SCROLLBACK_PRESETS, withSpace } from './settingsPresets'

const inRange = (key: RangedKey, values: number[]): void => {
  const { min, max } = SETTING_RANGES[key]
  for (const v of values) expect(v >= min && v <= max, `${key} preset ${v}`).toBe(true)
}

describe('settings presets', () => {
  it('stay inside SETTING_RANGES', () => {
    inRange('fontWeight', FONT_WEIGHT_OPTIONS.map((o) => o.value))
    inRange('gridSize', GRID_SIZE_OPTIONS.map((o) => o.value))
    inRange('defaultNodeWidth', NODE_WIDTH_OPTIONS.map((o) => o.value))
    inRange('defaultNodeHeight', NODE_HEIGHT_OPTIONS.map((o) => o.value))
    inRange('scrollbackBytes', REPLAY_BUFFER_OPTIONS.map((o) => o.value))
    inRange('scrollbackLines', SCROLLBACK_PRESETS.map((o) => Number(o.value)))
  })

  it('word separators always keep the space', () => {
    expect(withSpace('()')).toBe(' ()')
    expect(withSpace(' ()')).toBe(' ()')
  })
})
