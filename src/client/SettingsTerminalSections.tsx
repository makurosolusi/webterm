// Settings › Terminal: copy on select, who gets shortcuts first, and History length (one control for
// the terminal's scrollback AND the server's replay buffer). Everything else sits under Advanced.
// Each field names its `setting`, so the "Modified" dot and Reset compare it with `DEFAULT_SETTINGS`.
import { useEffect, useState } from 'react'
import type { Settings } from '../shared/settings'
import { TERMINAL_SCROLLBACK_LINES_MAX, TERMINAL_SCROLLBACK_LINES_MIN } from './terminalConfig'
import { SettingsAdvanced } from './SettingsControls'
import { SelectField, ToggleField } from './SettingsFields'
import { ComboboxField, integerIn, NumberSelectField, SliderField } from './SettingsPickerFields'
import { FONT_WEIGHT_OPTIONS, replayBytesFor, SCROLLBACK_PRESETS, shellPresets, withSpace, WORD_SEPARATOR_PRESETS } from './settingsPresets'

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

export function TerminalSection({ settings: s, onChange }: P): React.JSX.Element {
  const shells = useInstalledShells()
  return (
    <>
      <ToggleField setting="copyOnSelect" id="st-copyOnSelect" label="Copy on select" value={s.copyOnSelect}
        hint="Copy text to the clipboard as soon as you select it with the mouse."
        onChange={(v) => onChange({ copyOnSelect: v })} />
      <SelectField setting="terminalShortcutPolicy" id="st-shortcutPolicy" label="Keyboard shortcuts go to" value={s.terminalShortcutPolicy}
        hint="While you type in a terminal, who gets a shortcut that both could use."
        options={[
          { value: 'app-first', label: 'webterm first' },
          { value: 'terminal-first', label: 'The program in the terminal first' },
        ]}
        onChange={(v) => onChange({ terminalShortcutPolicy: v })} />
      <ComboboxField setting="scrollbackLines" id="st-scrollbackLines" fieldId="terminal.scrollbackLines" label="History length"
        value={String(s.scrollbackLines)} presets={SCROLLBACK_PRESETS}
        validate={integerIn(TERMINAL_SCROLLBACK_LINES_MIN, TERMINAL_SCROLLBACK_LINES_MAX, 'a number of lines')}
        hint="How many lines you can scroll back in a terminal; the same history is restored after a reload."
        onCommit={(v) => onChange({ scrollbackLines: Number(v), scrollbackBytes: replayBytesFor(Number(v)) })} />
      <SettingsAdvanced>
        <NumberSelectField setting="fontWeight" id="st-fontWeight" label="Normal text weight" value={s.fontWeight} options={FONT_WEIGHT_OPTIONS}
          onChange={(v) => onChange({ fontWeight: v })} />
        <NumberSelectField setting="fontWeightBold" id="st-fontWeightBold" label="Bold text weight" value={s.fontWeightBold} options={FONT_WEIGHT_OPTIONS}
          hint="Lower it when bold looks blurry on a thin font." onChange={(v) => onChange({ fontWeightBold: v })} />
        <ToggleField setting="drawBoldTextInBrightColors" id="st-drawBold" label="Draw bold text in bright colors" value={s.drawBoldTextInBrightColors}
          hint="Off keeps the colors a program chose; bold then only changes the weight."
          onChange={(v) => onChange({ drawBoldTextInBrightColors: v })} />
        <SliderField setting="terminalLineHeight" id="st-lineHeight" label="Line height" value={s.terminalLineHeight} range="terminalLineHeight"
          hint="A multiple of the font size." onChange={(v) => onChange({ terminalLineHeight: v })} />
        <SliderField setting="terminalLetterSpacing" id="st-letterSpacing" label="Letter spacing" value={s.terminalLetterSpacing} range="terminalLetterSpacing" unit="px"
          hint="Extra space between characters." onChange={(v) => onChange({ terminalLetterSpacing: v })} />
        <ComboboxField setting="terminalWordSeparator" id="st-wordSep" fieldId="terminal.wordSeparator" label="Word separators"
          value={s.terminalWordSeparator} mono trim={false} presets={WORD_SEPARATOR_PRESETS}
          hint="Characters that end a word when you double-click to select."
          onCommit={(v) => onChange({ terminalWordSeparator: withSpace(v) })} />
        <ToggleField setting="terminalFontZoomKeys" id="st-fontZoom" label="Keyboard font zoom" value={s.terminalFontZoomKeys}
          hint="⌘+ / ⌘− / ⌘0 (Ctrl elsewhere) change the font size of the focused terminal."
          onChange={(v) => onChange({ terminalFontZoomKeys: v })} />
        <ComboboxField setting="defaultShell" id="st-defaultShell" fieldId="terminal.defaultShell" label="Default shell" value={s.defaultShell} mono
          presets={shellPresets(shells)} placeholder="(system default shell)"
          hint="Shells installed on this computer. Applies to new terminals." onCommit={(v) => onChange({ defaultShell: v })} />
        <SliderField setting="terminalMinContrast" id="st-minContrast" label="Minimum contrast" value={s.terminalMinContrast} range="terminalMinContrast"
          hint="Raise it when colored text is hard to read; 4.5 is the usual readability level."
          onChange={(v) => onChange({ terminalMinContrast: v })} />
      </SettingsAdvanced>
    </>
  )
}
