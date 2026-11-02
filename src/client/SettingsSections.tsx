// Isi section Settings yang berupa daftar field polos (Terminal, Interaksi, Shell, Canvas, Preview).
// Dipisah dari `SettingsPanel.tsx` supaya chrome (header, pencarian, TOC) dan isi tidak berbagi
// satu file; tiap field menyebut `setting` agar penanda "Modified" dan Reset Setting bisa
// membandingkan nilainya dengan `DEFAULT_SETTINGS`.
import type { Settings } from '../shared/settings'
import {
  TERMINAL_SCROLLBACK_LINES_MAX,
  TERMINAL_SCROLLBACK_LINES_MIN,
} from './terminalConfig'
import { TERMINAL_THEMES } from './themes'
import {
  ColorField,
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
        <p className="st-note">Perubahan di section ini langsung diterapkan ke terminal yang terbuka.</p>
      )}
      <NumberField setting="fontSize" id="st-fontSize" label="Ukuran font" value={s.fontSize} min={6} max={48} unit="px"
        onChange={(v) => onChange({ fontSize: v })} />
      <TextField setting="fontFamily" id="st-fontFamily" label="Font family" value={s.fontFamily} mono
        hint="Daftar font CSS. Font monospace saja — font proporsional merusak perataan kolom TUI."
        onChange={(v) => onChange({ fontFamily: v })} />
      <NumberField setting="fontWeight" id="st-fontWeight" label="Bobot teks normal" value={s.fontWeight} min={100} max={900} step={100}
        hint="Default xterm sendiri normal (400)." onChange={(v) => onChange({ fontWeight: v })} />
      <NumberField setting="fontWeightBold" id="st-fontWeightBold" label="Bobot teks bold" value={s.fontWeightBold} min={100} max={900} step={100}
        hint="Default xterm sendiri bold (700). Menurunkannya adalah cara menjaga bold tetap terbaca pada font tipis yang merender 700 jadi gumpalan."
        onChange={(v) => onChange({ fontWeightBold: v })} />
      <ToggleField setting="drawBoldTextInBrightColors" id="st-drawBold" label="Bold pakai warna bright" value={s.drawBoldTextInBrightColors}
        hint="Default xterm, dan konvensi terminal historis. Off membuat bold murni soal bobot, sehingga warna tetap berarti apa yang program maksudkan."
        onChange={(v) => onChange({ drawBoldTextInBrightColors: v })} />
      <NumberField setting="terminalLineHeight" id="st-lineHeight" label="Tinggi baris" value={s.terminalLineHeight} min={0.8} max={3} step={0.05}
        hint="Kelipatan ukuran font. 1 = default xterm, tanpa leading tambahan."
        onChange={(v) => onChange({ terminalLineHeight: v })} />
      <NumberField setting="terminalLetterSpacing" id="st-letterSpacing" label="Spasi antar sel" value={s.terminalLetterSpacing} min={-2} max={10} step={0.5} unit="px"
        hint="Spasi horizontal ekstra antar sel. 0 = default xterm." onChange={(v) => onChange({ terminalLetterSpacing: v })} />
      <SelectField setting="terminalTheme" id="st-terminalTheme" label="Skema warna" value={s.terminalTheme}
        hint="Id tak dikenal jatuh ke tema default — nilainya bisa diedit tangan."
        options={TERMINAL_THEMES.map((t) => ({ value: t.id, label: `${t.label}${t.dark ? '' : ' (terang)'}` }))}
        onChange={(v) => onChange({ terminalTheme: v })} />
      <NumberField setting="terminalMinContrast" id="st-minContrast" label="Kontras minimum" value={s.terminalMinContrast} min={1} max={21} step={0.5}
        hint="Rasio kontras foreground/background. 1 (default xterm) mematikan penyesuaian sepenuhnya; 4.5 = WCAG AA, 7 = AAA, 21 memaksa hitam atau putih. Ada biaya kerja per sel di renderer, jadi tetap mati kecuali diminta."
        onChange={(v) => onChange({ terminalMinContrast: v })} />
      <SelectField setting="cursorStyle" id="st-cursorStyle" label="Bentuk kursor" value={s.cursorStyle}
        options={[
          { value: 'block', label: 'block' },
          { value: 'bar', label: 'bar' },
          { value: 'underline', label: 'underline' },
        ]}
        onChange={(v) => onChange({ cursorStyle: v })} />
      <SelectField setting="cursorInactiveStyle" id="st-cursorInactive" label="Kursor saat tidak fokus" value={s.cursorInactiveStyle}
        hint="outline (default xterm) itulah yang memberi tahu sekilas terminal mana di antara satu canvas penuh yang menerima ketikan."
        options={[
          { value: 'outline', label: 'outline' },
          { value: 'block', label: 'block' },
          { value: 'bar', label: 'bar' },
          { value: 'underline', label: 'underline' },
          { value: 'none', label: 'none' },
        ]}
        onChange={(v) => onChange({ cursorInactiveStyle: v })} />
      <ToggleField setting="cursorBlink" id="st-cursorBlink" label="Kursor berkedip" value={s.cursorBlink}
        onChange={(v) => onChange({ cursorBlink: v })} />
      <SelectField setting="terminalGpuRendering" id="st-gpu" label="Rendering GPU" value={s.terminalGpuRendering}
        hint="auto = satu konteks WebGL per terminal, dengan fallback otomatis ke renderer DOM bila konteksnya gagal dibuat atau hilang. off mengarahkan setiap terminal ke renderer DOM."
        options={[
          { value: 'auto', label: 'auto (WebGL per terminal)' },
          { value: 'off', label: 'off (renderer DOM)' },
        ]}
        onChange={(v) => onChange({ terminalGpuRendering: v })} />
    </>
  )
}

export function InteractionSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <TextField setting="terminalWordSeparator" id="st-wordSep" label="Pemisah kata" value={s.terminalWordSeparator} mono
        hint="Karakter yang mengakhiri kata saat seleksi double-click. Default mempertahankan tanda hubung, garis bawah, slash dan titik di dalam kata supaya identifier dan path terseleksi utuh."
        onChange={(v) => onChange({ terminalWordSeparator: v })} />
      <ToggleField setting="copyOnSelect" id="st-copyOnSelect" label="Salin saat seleksi" value={s.copyOnSelect}
        hint="Salin seleksi MOUSE yang selesai ke clipboard sistem. Off secara default: mengganti isi clipboard tanpa diminta adalah kejutan yang layak dipilih sendiri."
        onChange={(v) => onChange({ copyOnSelect: v })} />
      <ToggleField setting="terminalMiddleClickPaste" id="st-middleClick" label="Paste klik tengah" value={s.terminalMiddleClickPaste}
        hint="Off berarti tombol tengah sepenuhnya inert di dalam terminal. Defaultnya mati karena paste ini paling keras terasa di dalam TUI agent: satu klik nyasar menjatuhkan apa pun yang terakhir diseleksi ke prompt agent yang sedang hidup."
        onChange={(v) => onChange({ terminalMiddleClickPaste: v })} />
      <ToggleField setting="terminalFontZoomKeys" id="st-fontZoom" label="Zoom font via keyboard" value={s.terminalFontZoomKeys}
        hint="⌘+ / ⌘− / ⌘0 mengubah ukuran font terminal yang fokus. On secara default. Di luar macOS chord-nya Ctrl+= / Ctrl+− / Ctrl+0; matikan bila Ctrl+− bentrok dengan undo readline di shell."
        onChange={(v) => onChange({ terminalFontZoomKeys: v })} />
      <SelectField setting="terminalShortcutPolicy" id="st-shortcutPolicy" label="Prioritas shortcut" value={s.terminalShortcutPolicy}
        hint="Siapa yang menang selagi terminal memegang fokus keyboard."
        options={[
          { value: 'app-first', label: 'app-first — perintah app menyala di atas xterm' },
          { value: 'terminal-first', label: 'terminal-first — chord diserahkan ke shell/TUI' },
        ]}
        onChange={(v) => onChange({ terminalShortcutPolicy: v })} />
    </>
  )
}

export function ShellSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <TextField setting="defaultShell" id="st-defaultShell" label="Shell default" value={s.defaultShell} mono placeholder="(shell default sistem)"
        hint="Kosong = pakai shell default sistem." onChange={(v) => onChange({ defaultShell: v })} />
      <NumberField setting="scrollbackBytes" id="st-scrollback" label="Buffer replay server" value={s.scrollbackBytes} min={16 * 1024} max={64 * 1024 * 1024} step={16 * 1024} unit="byte"
        hint="Dalam BYTE: ring buffer byte mentah PTY di server, yang diputar ulang saat tab di-reload. Default 256 KiB (262144)."
        onChange={(v) => onChange({ scrollbackBytes: v })} />
      <NumberField setting="scrollbackLines" id="st-scrollbackLines" label="Scrollback terminal" value={s.scrollbackLines}
        min={TERMINAL_SCROLLBACK_LINES_MIN} max={TERMINAL_SCROLLBACK_LINES_MAX} step={1000} unit="baris"
        hint="Dalam BARIS: berapa jauh ke atas bisa discroll di dalam node terminal. Biayanya per node. Default 10000."
        onChange={(v) => onChange({ scrollbackLines: v })} />
    </>
  )
}

export function CanvasSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <>
      <NumberField setting="gridSize" id="st-gridSize" label="Ukuran grid" value={s.gridSize} min={4} max={200} unit="px"
        onChange={(v) => onChange({ gridSize: v })} />
      <ToggleField setting="snapToGrid" id="st-snapToGrid" label="Snap ke grid" value={s.snapToGrid}
        hint="Selagi on, menggeser node membulatkan posisinya ke grid." onChange={(v) => onChange({ snapToGrid: v })} />
      <ToggleField setting="canvasDots" id="st-canvasDots" label="Titik grid" value={s.canvasDots}
        hint="Tampilan saja — snapping tidak berubah." onChange={(v) => onChange({ canvasDots: v })} />
      <ColorField setting="accent" id="st-accent" label="Warna aksen" value={s.accent} onChange={(v) => onChange({ accent: v })} />
      <NumberField setting="defaultNodeWidth" id="st-nodeW" label="Lebar node baru" value={s.defaultNodeWidth} min={200} max={4000} step={20} unit="px"
        hint="Node yang sudah ada tetap memakai ukuran yang tersimpan bersamanya."
        onChange={(v) => onChange({ defaultNodeWidth: v })} />
      <NumberField setting="defaultNodeHeight" id="st-nodeH" label="Tinggi node baru" value={s.defaultNodeHeight} min={120} max={4000} step={20} unit="px"
        onChange={(v) => onChange({ defaultNodeHeight: v })} />
      <SelectField setting="appTheme" id="st-appTheme" label="Tema app" value={s.appTheme}
        hint="Tampilan chrome app (panel, header node, menu). auto mengambilnya dari tema warna terminal, sehingga memilih tema terminal terang tidak menyisakan rangka hitam."
        options={[
          { value: 'auto', label: 'auto (ikut tema terminal)' },
          { value: 'dark', label: 'dark' },
          { value: 'light', label: 'light' },
        ]}
        onChange={(v) => onChange({ appTheme: v })} />
    </>
  )
}

export function PreviewSection({ settings: s, onChange }: P): React.JSX.Element {
  return (
    <ToggleField setting="openMarkdownPreview" id="st-openMarkdownPreview" label="Buka Markdown sebagai preview" value={s.openMarkdownPreview}
      hint="Buka file Markdown dalam preview terender alih-alih editor kode. Hanya menentukan tampilan saat node editor DIBUKA — toggle Preview/Edit node tetap bisa berpindah dua arah."
      onChange={(v) => onChange({ openMarkdownPreview: v })} />
  )
}
