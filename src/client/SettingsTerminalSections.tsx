// Section Terminal, Interaksi, dan Shell & buffer di Settings: daftar field polos. Tiap field
// menyebut `setting` agar penanda "Modified" dan Reset Setting bisa membandingkan nilainya dengan
// `DEFAULT_SETTINGS`. Urutan Terminal: font, tema (skema warna + tema app), kursor, buffer.
import type { Settings } from '../shared/settings'
import {
  TERMINAL_SCROLLBACK_LINES_MAX,
  TERMINAL_SCROLLBACK_LINES_MIN,
} from './terminalConfig'
import { TERMINAL_THEMES } from './themes'
import {
  NumberField,
  SelectField,
  TextField,
  ToggleField,
  useSettingsSearch,
} from './SettingsFields'

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
      <NumberField setting="fontSize" id="st-fontSize" label="Font size" value={s.fontSize} min={6} max={48} unit="px"
        onChange={(v) => onChange({ fontSize: v })} />
      <TextField setting="fontFamily" id="st-fontFamily" label="Font family" value={s.fontFamily} mono
        hint="A CSS font list. Monospace fonts only — proportional fonts break TUI column alignment."
        onChange={(v) => onChange({ fontFamily: v })} />
      <NumberField setting="fontWeight" id="st-fontWeight" label="Normal text weight" value={s.fontWeight} min={100} max={900} step={100}
        hint="xterm’s own default is normal (400)." onChange={(v) => onChange({ fontWeight: v })} />
      <NumberField setting="fontWeightBold" id="st-fontWeightBold" label="Bold text weight" value={s.fontWeightBold} min={100} max={900} step={100}
        hint="xterm’s own default is bold (700). Lowering it keeps bold readable on thin fonts that render 700 as a blob."
        onChange={(v) => onChange({ fontWeightBold: v })} />
      <ToggleField setting="drawBoldTextInBrightColors" id="st-drawBold" label="Draw bold text in bright colors" value={s.drawBoldTextInBrightColors}
        hint="The xterm default and a historical terminal convention. Off makes bold purely about weight, so colors keep the meaning the program intended."
        onChange={(v) => onChange({ drawBoldTextInBrightColors: v })} />
      <NumberField setting="terminalLineHeight" id="st-lineHeight" label="Line height" value={s.terminalLineHeight} min={0.8} max={3} step={0.05}
        hint="A multiple of the font size. 1 = the xterm default, no extra leading."
        onChange={(v) => onChange({ terminalLineHeight: v })} />
      <NumberField setting="terminalLetterSpacing" id="st-letterSpacing" label="Letter spacing" value={s.terminalLetterSpacing} min={-2} max={10} step={0.5} unit="px"
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
      <NumberField setting="terminalMinContrast" id="st-minContrast" label="Minimum contrast" value={s.terminalMinContrast} min={1} max={21} step={0.5}
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
      <NumberField setting="scrollbackLines" id="st-scrollbackLines" label="Terminal scrollback" value={s.scrollbackLines}
        min={TERMINAL_SCROLLBACK_LINES_MIN} max={TERMINAL_SCROLLBACK_LINES_MAX} step={1000} unit="lines"
        hint="In LINES: how far up you can scroll inside a terminal node. The cost is per node. Default 10000."
        onChange={(v) => onChange({ scrollbackLines: v })} />
    </>
  )
}

export function InteractionSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <TextField setting="terminalWordSeparator" id="st-wordSep" label="Word separators" value={s.terminalWordSeparator} mono
        hint="Characters that end a word on double-click selection. The default keeps hyphens, underscores, slashes, and dots inside words so identifiers and paths are selected whole."
        onChange={(v) => onChange({ terminalWordSeparator: v })} />
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
      <TextField setting="defaultShell" id="st-defaultShell" label="Default shell" value={s.defaultShell} mono placeholder="(system default shell)"
        hint="Empty = use the system default shell." onChange={(v) => onChange({ defaultShell: v })} />
      <NumberField setting="scrollbackBytes" id="st-scrollback" label="Server replay buffer" value={s.scrollbackBytes} min={16 * 1024} max={64 * 1024 * 1024} step={16 * 1024} unit="bytes"
        hint="In BYTES: a ring buffer of raw PTY bytes on the server, replayed when the tab reloads. Default 256 KiB (262144)."
        onChange={(v) => onChange({ scrollbackBytes: v })} />
    </>
  )
}
