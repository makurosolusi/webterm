// Settings › Appearance: theme, terminal color scheme (with a preview), font, cursor, and the canvas
// background. Every change applies live. The font list holds only fonts installed on this computer.
import { useMemo } from 'react'
import type { Settings } from '../shared/settings'
import type { SettingsPatch } from '../shared/settings.patch'
import { CanvasBackgroundSection } from './CanvasBackgroundSection'
import { SettingsSelect } from './SettingsControls'
import { Field, SelectField, ToggleField } from './SettingsFields'
import { ComboboxField, StepperField } from './SettingsPickerFields'
import { installedFontPresets } from './settingsPresets'
import { resolveTerminalTheme, TERMINAL_THEMES } from './themes'

interface P {
  settings: Settings
  onChange: (patch: SettingsPatch) => void
  /** Active workspace, for the canvas background's "This workspace" choice. */
  projectId?: string
}

const ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

/** A few lines drawn in the scheme's own colors, so a choice can be judged before opening a terminal. */
function SchemePreview({ id, font }: { id: string; font: string }): React.JSX.Element {
  const t = resolveTerminalTheme(id).theme
  return (
    <div data-testid="scheme-preview" aria-hidden="true"
      style={{ background: t.background, color: t.foreground, fontFamily: font, fontSize: 12, padding: '6px 10px', borderRadius: 4, marginTop: 6, lineHeight: 1.5 }}>
      <div><span style={{ color: t.green }}>~/project</span> <span style={{ color: t.blue }}>main</span> $ ls</div>
      <div>{ANSI.map((c) => <span key={c} style={{ color: t[c], marginRight: 8 }}>{c}</span>)}</div>
    </div>
  )
}

export function AppearanceSection({ settings: s, onChange, projectId }: P): React.JSX.Element {
  const fonts = useMemo(installedFontPresets, [])
  return (
    <>
      <SelectField setting="appTheme" id="st-appTheme" label="Theme" value={s.appTheme}
        hint="System follows your computer’s light or dark mode."
        options={[
          { value: 'auto', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        onChange={(v) => onChange({ appTheme: v })} />
      <Field label="Terminal colors" htmlFor="st-terminalTheme" setting="terminalTheme">
        <div className="flex min-w-0 flex-1 flex-col">
          <SettingsSelect id="st-terminalTheme" value={s.terminalTheme}
            options={TERMINAL_THEMES.map((t) => ({ value: t.id, label: `${t.label}${t.dark ? '' : ' (light)'}` }))}
            onChange={(v) => onChange({ terminalTheme: v })} />
          <SchemePreview id={s.terminalTheme} font={s.fontFamily} />
        </div>
      </Field>
      <ComboboxField setting="fontFamily" id="st-fontFamily" fieldId="terminal.fontFamily" label="Font" value={s.fontFamily} mono
        presets={fonts} validate={(v) => (v ? null : 'Pick or enter a font.')}
        hint="Fonts installed on this computer. Monospace fonts keep columns lined up."
        onCommit={(v) => onChange({ fontFamily: v })} />
      <StepperField setting="fontSize" id="st-fontSize" label="Font size" value={s.fontSize} range="fontSize" unit="px"
        onChange={(v) => onChange({ fontSize: v })} />
      <SelectField setting="cursorStyle" id="st-cursorStyle" label="Cursor style" value={s.cursorStyle}
        options={[
          { value: 'block', label: 'Block' },
          { value: 'bar', label: 'Bar' },
          { value: 'underline', label: 'Underline' },
        ]}
        onChange={(v) => onChange({ cursorStyle: v })} />
      <ToggleField setting="cursorBlink" id="st-cursorBlink" label="Cursor blink" value={s.cursorBlink}
        onChange={(v) => onChange({ cursorBlink: v })} />
      <CanvasBackgroundSection settings={s} onChange={onChange} projectId={projectId} />
    </>
  )
}
