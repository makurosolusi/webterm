// Settings › Appearance: the app's own look (macOS Appearance): the theme and the canvas background.
// Terminal colors, font and cursor live on Settings › Terminal › Look. Every change applies live.
import type { AppTheme, Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { CanvasBackgroundSection } from './CanvasBackgroundSection'
import { SettingsGroup, type SegmentedOption } from './SettingsControls'
import { SegmentedField } from './SettingsFields'
import { HeaderModeField } from './SettingsHeaderMode'

interface P {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
  /** Active workspace, for the canvas background's "This workspace" choice. */
  projectId?: string
}

const swatch = (theme: AppTheme): React.JSX.Element => <span className={`st-theme-swatch st-theme-swatch--${theme}`} />

/** Light / Dark / System, each with a small swatch (GitHub, Linear). */
export const THEME_OPTIONS: readonly SegmentedOption<AppTheme>[] = [
  { value: 'light', label: 'Light', glyph: swatch('light') },
  { value: 'dark', label: 'Dark', glyph: swatch('dark') },
  { value: 'auto', label: 'System', glyph: swatch('auto') },
]

export function AppearanceSection({ settings: s, onChange, projectId }: P): React.JSX.Element {
  return (
    <>
      <SettingsGroup title="Theme">
        <SegmentedField setting="appTheme" id="st-appTheme" label="Theme" value={s.appTheme} options={THEME_OPTIONS}
          hint="System follows your computer’s light or dark mode." onChange={(v) => onChange({ appTheme: v })} />
      </SettingsGroup>
      <HeaderModeField />
      <CanvasBackgroundSection settings={s} onChange={onChange} projectId={projectId} />
    </>
  )
}
