// Preset lists never offer a value the setting's range would clamp away.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SETTING_RANGES, type RangedKey } from '../shared/settings.ranges'
import { FONT_WEIGHT_OPTIONS, GRID_SIZE_OPTIONS, installedFontPresets, replayBytesFor, SCROLLBACK_PRESETS, shellPresets, withSpace } from './settingsPresets'
import { resetFontDetect } from './fontDetect'

const inRange = (key: RangedKey, values: number[]): void => {
  const { min, max } = SETTING_RANGES[key]
  for (const v of values) expect(v >= min && v <= max, `${key} preset ${v}`).toBe(true)
}

afterEach(() => { vi.unstubAllGlobals(); resetFontDetect() })

describe('settings presets', () => {
  it('stay inside SETTING_RANGES', () => {
    inRange('fontWeight', FONT_WEIGHT_OPTIONS.map((o) => o.value))
    inRange('gridSize', GRID_SIZE_OPTIONS.map((o) => o.value))
    inRange('scrollbackLines', SCROLLBACK_PRESETS.map((o) => Number(o.value)))
    inRange('scrollbackBytes', SCROLLBACK_PRESETS.map((o) => replayBytesFor(Number(o.value))))
  })

  it('History length drives the replay buffer: the default maps to the default, more lines to more bytes', () => {
    expect(replayBytesFor(DEFAULT_SETTINGS.scrollbackLines)).toBe(DEFAULT_SETTINGS.scrollbackBytes)
    expect(replayBytesFor(50_000)).toBeGreaterThan(DEFAULT_SETTINGS.scrollbackBytes)
    expect(replayBytesFor(1_000)).toBeLessThan(DEFAULT_SETTINGS.scrollbackBytes)
    expect(replayBytesFor(1_000) % SETTING_RANGES.scrollbackBytes.step).toBe(0)
  })

  it('word separators always keep the space', () => {
    expect(withSpace('()')).toBe(' ()')
    expect(withSpace(' ()')).toBe(' ()')
  })

  it('shell presets: system default first, then the installed shells', () => {
    expect(shellPresets(['/bin/zsh']).map((p) => p.value)).toEqual(['', '/bin/zsh'])
  })

  it('font presets list only installed fonts, the default named after the font it renders', () => {
    // Fake canvas: "Menlo" and "JetBrains Mono" measure differently from the generic fallbacks; nothing else does.
    const installed = ['Menlo', 'JetBrains Mono']
    const ctx = { font: '', measureText(this: { font: string }) { return { width: installed.some((f) => this.font.includes(`"${f}"`)) ? 2 : 1 } } }
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) })
    const presets = installedFontPresets()
    expect(presets[0]).toEqual({ value: DEFAULT_SETTINGS.fontFamily, label: 'Menlo (default)' })
    expect(presets.map((p) => p.label)).toEqual(['Menlo (default)', 'JetBrains Mono', 'System monospace'])
  })
})
