// Section Terminal, Interaksi, dan Shell & buffer di Settings: daftar field polos. Tiap field
// menyebut `setting` agar penanda "Modified" dan Reset Setting bisa membandingkan nilainya dengan
// `DEFAULT_SETTINGS`. Urutan Terminal: font, tema (skema warna + tema app), kursor, buffer.
import type { Settings } from '../shared/settings'
import {
  TERMINAL_SCROLLBACK_LINES_MAX,
  TERMINAL_SCROLLBACK_LINES_MIN,
} from './terminalConfig'
import { TERMINAL_THEMES } from './themes'
import { ProjectsFolderSetting } from './workspaceCreate/ProjectsFolderSetting'
import { SelectField, ToggleField, useSettingsSearch } from './SettingsFields'
import { ComboboxField, integerIn, NumberSelectField, SliderField, StepperField } from './SettingsPickerFields'
import { FONT_FAMILY_PRESETS, FONT_WEIGHT_OPTIONS, REPLAY_BUFFER_OPTIONS, SCROLLBACK_PRESETS, SHELL_PRESETS, withSpace, WORD_SEPARATOR_PRESETS } from './settingsPresets'

interface P {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function TerminalSection({ settings: s, onChange }: P): React.JSX.Element {
  const query = useSettingsSearch()
  return (
    <>
      {query ? null : (
        <p className="st-note">Changes in this section apply immediately to open terminals.</p>
      )}
      <StepperField setting="fontSize" id="st-fontSize" label="Font size" value={s.fontSize} range="fontSize" unit="px"
        onChange={(v) => onChange({ fontSize: v })} />
      <ComboboxField setting="fontFamily" id="st-fontFamily" fieldId="terminal.fontFamily" label="Font family" value={s.fontFamily} mono
        presets={FONT_FAMILY_PRESETS} validate={(v) => (v ? null : 'Pick or enter a font.')}
        hint="A CSS font list. Monospace fonts only — proportional fonts break TUI column alignment."
        onCommit={(v) => onChange({ fontFamily: v })} />
      <NumberSelectField setting="fontWeight" id="st-fontWeight" label="Normal text weight" value={s.fontWeight} options={FONT_WEIGHT_OPTIONS}
        hint="xterm’s own default is normal (400)." onChange={(v) => onChange({ fontWeight: v })} />
      <NumberSelectField setting="fontWeightBold" id="st-fontWeightBold" label="Bold text weight" value={s.fontWeightBold} options={FONT_WEIGHT_OPTIONS}
        hint="xterm’s own default is bold (700). Lowering it keeps bold readable on thin fonts that render 700 as a blob."
        onChange={(v) => onChange({ fontWeightBold: v })} />
      <ToggleField setting="drawBoldTextInBrightColors" id="st-drawBold" label="Draw bold text in bright colors" value={s.drawBoldTextInBrightColors}
        hint="The xterm default and a historical terminal convention. Off makes bold purely about weight, so colors keep the meaning the program intended."
        onChange={(v) => onChange({ drawBoldTextInBrightColors: v })} />
      <SliderField setting="terminalLineHeight" id="st-lineHeight" label="Line height" value={s.terminalLineHeight} range="terminalLineHeight"
        hint="A multiple of the font size. 1 = the xterm default, no extra leading."
        onChange={(v) => onChange({ terminalLineHeight: v })} />
      <SliderField setting="terminalLetterSpacing" id="st-letterSpacing" label="Letter spacing" value={s.terminalLetterSpacing} range="terminalLetterSpacing" unit="px"
        hint="Extra horizontal space between cells. 0 = the xterm default." onChange={(v) => onChange({ terminalLetterSpacing: v })} />
      <SelectField setting="terminalTheme" id="st-terminalTheme" label="Color scheme" value={s.terminalTheme}
        hint="Unknown ids fall back to the default theme — the value can be edited by hand."
        options={TERMINAL_THEMES.map((t) => ({ value: t.id, label: `${t.label}${t.dark ? '' : ' (light)'}` }))}
        onChange={(v) => onChange({ terminalTheme: v })} />
      <SelectField setting="appTheme" id="st-appTheme" label="App theme" value={s.appTheme}
        hint="The look of the app chrome (panels, node headers, menus). auto follows the terminal color scheme, so picking a light terminal theme doesn’t leave a dark frame."
        options={[
          { value: 'auto', label: 'auto (follow terminal theme)' },
          { value: 'dark', label: 'dark' },
          { value: 'light', label: 'light' },
        ]}
        onChange={(v) => onChange({ appTheme: v })} />
      <SliderField setting="terminalMinContrast" id="st-minContrast" label="Minimum contrast" value={s.terminalMinContrast} range="terminalMinContrast"
        hint="Foreground/background contrast ratio. 1 (the xterm default) turns adjustment off entirely; 4.5 = WCAG AA, 7 = AAA, 21 forces black or white. It costs work per cell in the renderer, so it stays off unless requested."
        onChange={(v) => onChange({ terminalMinContrast: v })} />
      <SelectField setting="cursorStyle" id="st-cursorStyle" label="Cursor style" value={s.cursorStyle}
        options={[
          { value: 'block', label: 'block' },
          { value: 'bar', label: 'bar' },
          { value: 'underline', label: 'underline' },
        ]}
        onChange={(v) => onChange({ cursorStyle: v })} />
      <SelectField setting="cursorInactiveStyle" id="st-cursorInactive" label="Inactive cursor style" value={s.cursorInactiveStyle}
        hint="outline (the xterm default) is what tells you at a glance which terminal on a full canvas receives your typing."
        options={[
          { value: 'outline', label: 'outline' },
          { value: 'block', label: 'block' },
          { value: 'bar', label: 'bar' },
          { value: 'underline', label: 'underline' },
          { value: 'none', label: 'none' },
        ]}
        onChange={(v) => onChange({ cursorInactiveStyle: v })} />
      <ToggleField setting="cursorBlink" id="st-cursorBlink" label="Cursor blink" value={s.cursorBlink}
        onChange={(v) => onChange({ cursorBlink: v })} />
      <SelectField setting="terminalGpuRendering" id="st-gpu" label="GPU rendering" value={s.terminalGpuRendering}
        hint="auto = one WebGL context per terminal, falling back to the DOM renderer automatically if the context fails or is lost. off routes every terminal to the DOM renderer."
        options={[
          { value: 'auto', label: 'auto (WebGL per terminal)' },
          { value: 'off', label: 'off (DOM renderer)' },
        ]}
        onChange={(v) => onChange({ terminalGpuRendering: v })} />
      <ComboboxField setting="scrollbackLines" id="st-scrollbackLines" fieldId="terminal.scrollbackLines" label="Terminal scrollback"
        value={String(s.scrollbackLines)} presets={SCROLLBACK_PRESETS}
        validate={integerIn(TERMINAL_SCROLLBACK_LINES_MIN, TERMINAL_SCROLLBACK_LINES_MAX, 'a number of lines')}
        hint="In LINES: how far up you can scroll inside a terminal node. The cost is per node. Default 10000."
        onCommit={(v) => onChange({ scrollbackLines: Number(v) })} />
    </>
  )
}

export function InteractionSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <ComboboxField setting="terminalWordSeparator" id="st-wordSep" fieldId="terminal.wordSeparator" label="Word separators"
        value={s.terminalWordSeparator} mono trim={false} presets={WORD_SEPARATOR_PRESETS}
        hint="Characters that end a word on double-click selection; a space always does. The default keeps hyphens, underscores, slashes, and dots inside words so identifiers and paths are selected whole."
        onCommit={(v) => onChange({ terminalWordSeparator: withSpace(v) })} />
      <ToggleField setting="copyOnSelect" id="st-copyOnSelect" label="Copy on select" value={s.copyOnSelect}
        hint="Copy a finished MOUSE selection to the system clipboard. Off by default: replacing the clipboard unasked is a surprise you should opt into."
        onChange={(v) => onChange({ copyOnSelect: v })} />
      <ToggleField setting="terminalMiddleClickPaste" id="st-middleClick" label="Middle-click paste" value={s.terminalMiddleClickPaste}
        hint="Off means the middle button is completely inert inside the terminal. It is off by default because this paste hits hardest in agent TUIs: one stray click drops whatever was last selected into a live agent prompt."
        onChange={(v) => onChange({ terminalMiddleClickPaste: v })} />
      <ToggleField setting="terminalFontZoomKeys" id="st-fontZoom" label="Keyboard font zoom" value={s.terminalFontZoomKeys}
        hint="⌘+ / ⌘− / ⌘0 change the font size of the focused terminal. On by default. Outside macOS the chords are Ctrl+= / Ctrl+− / Ctrl+0; turn this off if Ctrl+− clashes with readline undo in your shell."
        onChange={(v) => onChange({ terminalFontZoomKeys: v })} />
      <SelectField setting="terminalShortcutPolicy" id="st-shortcutPolicy" label="Shortcut priority" value={s.terminalShortcutPolicy}
        hint="Who wins while a terminal holds keyboard focus."
        options={[
          { value: 'app-first', label: 'app-first — app commands fire over xterm' },
          { value: 'terminal-first', label: 'terminal-first — chords go to the shell/TUI' },
        ]}
        onChange={(v) => onChange({ terminalShortcutPolicy: v })} />
      <ToggleField setting="openMarkdownPreview" id="st-openMarkdownPreview" label="Open Markdown as preview" value={s.openMarkdownPreview}
        hint="Open Markdown files in a rendered preview instead of the code editor. Only decides the view when an editor node is OPENED — the node’s Preview/Edit toggle still switches both ways."
        onChange={(v) => onChange({ openMarkdownPreview: v })} />
    </>
  )
}

export function ShellSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <ComboboxField setting="defaultShell" id="st-defaultShell" fieldId="terminal.defaultShell" label="Default shell" value={s.defaultShell} mono
        presets={SHELL_PRESETS} placeholder="(system default shell)"
        hint="Empty = use the system default shell." onCommit={(v) => onChange({ defaultShell: v })} />
      <NumberSelectField setting="scrollbackBytes" id="st-scrollback" label="Server replay buffer" value={s.scrollbackBytes} options={REPLAY_BUFFER_OPTIONS}
        hint="A ring buffer of raw terminal output on the server, replayed when the tab reloads. Default 256 KiB."
        onChange={(v) => onChange({ scrollbackBytes: v })} />
      <ProjectsFolderSetting value={s.defaultProjectsFolder} onChange={(v) => onChange({ defaultProjectsFolder: v })} />
    </>
  )
}
