// Settings › Terminal, everything about terminals in one page (VS Code keeps terminal typography under
// Terminal): "Look" (one live preview, colors, font, size, weights, spacing, cursor), "Behavior" (copy
// on select, shortcut priority, History length = the terminal's scrollback AND the server's replay
// buffer, shell, zoom keys), and Advanced. Field ids stay as before, so old deep links still land here.
// Each field names its `setting`, so the "Modified" dot and Reset compare it with `DEFAULT_SETTINGS`.
import { useEffect, useMemo, useState } from 'react'
import type { Settings, TerminalCursorStyle, TerminalShortcutPolicy } from '../shared/settings'
import { TERMINAL_SCROLLBACK_LINES_MAX, TERMINAL_SCROLLBACK_LINES_MIN } from './terminalConfig'
import { SettingsAdvanced, SettingsGroup, SettingsSelect, type SegmentedOption } from './SettingsControls'
import { Field, SegmentedField, ToggleField } from './SettingsFields'
import { ComboboxField, integerIn, NumberSelectField, SliderField, StepperField } from './SettingsPickerFields'
import { firstFamily } from './fontDetect'
import {
  FONT_WEIGHT_OPTIONS, formatLines, installedFontPresets, replayBytesFor, SCROLLBACK_PRESETS, shellPresets, withSpace, WORD_SEPARATOR_PRESETS,
} from './settingsPresets'
import { TerminalPreview } from './TerminalPreview'
import { TERMINAL_THEMES } from './themes'

interface P {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

const SHELLS_PATH = '/api/settings/shells'

/** Shells installed on the server's machine; [] while loading or when the list is unavailable. */
function useInstalledShells(): string[] {
  const [shells, setShells] = useState<string[]>([])
  useEffect(() => {
    const ac = new AbortController()
    fetch(SHELLS_PATH, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((v: { shells?: unknown }) => setShells(Array.isArray(v.shells) ? v.shells.filter((x): x is string => typeof x === 'string') : []))
      .catch((err: unknown) => {
        if (!ac.signal.aborted) console.warn('[webterm] listing installed shells failed; Default shell offers the system default only', err)
      })
    return () => ac.abort()
  }, [])
  return shells
}

export const CURSOR_OPTIONS: readonly SegmentedOption<TerminalCursorStyle>[] = [
  { value: 'block', label: 'Block', glyph: '█' },
  { value: 'bar', label: 'Bar', glyph: '▏' },
  { value: 'underline', label: 'Underline', glyph: '▁' },
]

/** Stored values stay `app-first` / `terminal-first`; only the words changed. */
export const SHORTCUT_PRIORITY_OPTIONS: readonly SegmentedOption<TerminalShortcutPolicy>[] = [
  { value: 'app-first', label: 'webterm' },
  { value: 'terminal-first', label: 'Terminal program' },
]

const lineHeightText = (v: number): string => `${v.toFixed(1)}×`

function LookGroup({ settings: s, onChange }: P): React.JSX.Element {
  const fonts = useMemo(installedFontPresets, [])
  return (
    <SettingsGroup title="Look">
      <Field label="Preview" hint="Shows your colors, font, spacing and cursor as you change them." block>
        <TerminalPreview settings={s} />
      </Field>
      <Field label="Terminal colors" htmlFor="st-terminalTheme" setting="terminalTheme">
        <SettingsSelect id="st-terminalTheme" value={s.terminalTheme}
          options={TERMINAL_THEMES.map((t) => ({ value: t.id, label: `${t.label}${t.dark ? '' : ' (light)'}` }))}
          onChange={(v) => onChange({ terminalTheme: v })} />
      </Field>
      <ComboboxField setting="fontFamily" id="st-fontFamily" fieldId="terminal.fontFamily" label="Font" value={s.fontFamily} fontPreview
        presets={fonts} format={firstFamily} validate={(v) => (v ? null : 'Pick or enter a font.')}
        hint="Fonts installed on this computer. Monospace fonts keep columns lined up."
        onCommit={(v) => onChange({ fontFamily: v })} />
      <StepperField setting="fontSize" id="st-fontSize" label="Font size" value={s.fontSize} range="fontSize" unit="px"
        onChange={(v) => onChange({ fontSize: v })} />
      <NumberSelectField setting="fontWeight" id="st-fontWeight" label="Normal text weight" value={s.fontWeight} options={FONT_WEIGHT_OPTIONS}
        onChange={(v) => onChange({ fontWeight: v })} />
      <NumberSelectField setting="fontWeightBold" id="st-fontWeightBold" label="Bold text weight" value={s.fontWeightBold} options={FONT_WEIGHT_OPTIONS}
        hint="Lower it when bold looks blurry on a thin font." onChange={(v) => onChange({ fontWeightBold: v })} />
      <SliderField setting="terminalLineHeight" id="st-lineHeight" label="Line height" value={s.terminalLineHeight} range="terminalLineHeight"
        format={lineHeightText} hint="A multiple of the font size." onChange={(v) => onChange({ terminalLineHeight: v })} />
      <SliderField setting="terminalLetterSpacing" id="st-letterSpacing" label="Letter spacing" value={s.terminalLetterSpacing} range="terminalLetterSpacing" unit="px"
        hint="Extra space between characters." onChange={(v) => onChange({ terminalLetterSpacing: v })} />
      <SegmentedField setting="cursorStyle" id="st-cursorStyle" label="Cursor style" value={s.cursorStyle} options={CURSOR_OPTIONS}
        onChange={(v) => onChange({ cursorStyle: v })} />
      <ToggleField setting="cursorBlink" id="st-cursorBlink" label="Cursor blink" value={s.cursorBlink}
        onChange={(v) => onChange({ cursorBlink: v })} />
    </SettingsGroup>
  )
}

export function TerminalSection({ settings: s, onChange }: P): React.JSX.Element {
  const shells = useInstalledShells()
  return (
    <>
      <LookGroup settings={s} onChange={onChange} />
      <SettingsGroup title="Behavior">
        <ToggleField setting="copyOnSelect" id="st-copyOnSelect" label="Copy on select" value={s.copyOnSelect}
          hint="Copy text to the clipboard as soon as you select it with the mouse."
          onChange={(v) => onChange({ copyOnSelect: v })} />
        <SegmentedField setting="terminalShortcutPolicy" id="st-shortcutPolicy" label="Shortcut priority" value={s.terminalShortcutPolicy}
          hint="While you type in a terminal, who gets a shortcut that both could use."
          options={SHORTCUT_PRIORITY_OPTIONS} onChange={(v) => onChange({ terminalShortcutPolicy: v })} />
        <ComboboxField setting="scrollbackLines" id="st-scrollbackLines" fieldId="terminal.scrollbackLines" label="History length"
          value={String(s.scrollbackLines)} presets={SCROLLBACK_PRESETS} format={formatLines}
          validate={integerIn(TERMINAL_SCROLLBACK_LINES_MIN, TERMINAL_SCROLLBACK_LINES_MAX, 'a number of lines')}
          hint="How many lines you can scroll back in a terminal; the same history is restored after a reload."
          onCommit={(v) => onChange({ scrollbackLines: Number(v), scrollbackBytes: replayBytesFor(Number(v)) })} />
        <ComboboxField setting="defaultShell" id="st-defaultShell" fieldId="terminal.defaultShell" label="Default shell" value={s.defaultShell} mono
          presets={shellPresets(shells)} placeholder="(system default shell)"
          hint="Shells installed on this computer. Applies to new terminals." onCommit={(v) => onChange({ defaultShell: v })} />
        <ToggleField setting="terminalFontZoomKeys" id="st-fontZoom" label="Keyboard font zoom" value={s.terminalFontZoomKeys}
          hint="⌘+ / ⌘− / ⌘0 (Ctrl elsewhere) change the font size of the focused terminal."
          onChange={(v) => onChange({ terminalFontZoomKeys: v })} />
      </SettingsGroup>
      <SettingsAdvanced>
        <ComboboxField setting="terminalWordSeparator" id="st-wordSep" fieldId="terminal.wordSeparator" label="Word separators"
          value={s.terminalWordSeparator} mono trim={false} presets={WORD_SEPARATOR_PRESETS}
          hint="Characters that end a word when you double-click to select."
          onCommit={(v) => onChange({ terminalWordSeparator: withSpace(v) })} />
        <SliderField setting="terminalMinContrast" id="st-minContrast" label="Minimum contrast" value={s.terminalMinContrast} range="terminalMinContrast"
          hint="Raise it when colored text is hard to read; 4.5 is the usual readability level."
          onChange={(v) => onChange({ terminalMinContrast: v })} />
        <ToggleField setting="drawBoldTextInBrightColors" id="st-drawBold" label="Draw bold text in bright colors" value={s.drawBoldTextInBrightColors}
          hint="Off keeps the colors a program chose; bold then only changes the weight."
          onChange={(v) => onChange({ drawBoldTextInBrightColors: v })} />
      </SettingsAdvanced>
    </>
  )
}
