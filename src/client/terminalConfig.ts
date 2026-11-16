import type { FontWeight, ITheme } from '@xterm/xterm'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { clampSetting, SETTING_RANGES } from '../shared/settings.ranges'
import type {
  Settings,
  TerminalCursorStyle,
} from '../shared/settings'
import { resolveTerminalTheme } from './themes'

/**
 * Keputusan murni di balik instance xterm di `TerminalCore` — 
 * `src/renderer/terminal/terminal-config.ts`, dipersempit ke bagian APPEARANCE-nya.
 *
 * Diekstrak ke modul sendiri supaya bisa dites tanpa harness xterm/DOM: vitest webterm jalan di
 * environment node, tidak ada jsdom. Yang TIDAK ada: seluruh mesin co-attach
 * (`reportedSize`, letterbox, `TermSize`), seeding tmux (`attachReplay`, `seedPaint`,
 * `repaintResync`, OSC 52), park/adopt, dan tema "glass" — webterm tidak punya tmux, tidak punya
 * satu-pty-N-subscriber, dan tidak punya latar translusen di balik terminal.
 *
 * Satu sumber untuk DUA jalur: opsi saat `new Terminal({...})` (`xtermOptionsFromSettings`) dan
 * perubahan ke terminal yang sudah hidup (`applyLiveOptions`), supaya opsi baru tidak bisa
 * mendarat di satu jalur saja.
 */

// Rentang hidup di `settings.ranges.ts` (satu sumber). Nama ekspor di bawah dipertahankan sebagai
// alias tabel supaya pemakai lama (UI settings, tes) tidak menyalin angkanya.
export const TERMINAL_LINE_HEIGHT_MIN = SETTING_RANGES.terminalLineHeight.min
export const TERMINAL_LINE_HEIGHT_MAX = SETTING_RANGES.terminalLineHeight.max
export const TERMINAL_LETTER_SPACING_MIN = SETTING_RANGES.terminalLetterSpacing.min
export const TERMINAL_LETTER_SPACING_MAX = SETTING_RANGES.terminalLetterSpacing.max
export const TERMINAL_FONT_WEIGHT_MIN = SETTING_RANGES.fontWeight.min
export const TERMINAL_FONT_WEIGHT_MAX = SETTING_RANGES.fontWeight.max
export const TERMINAL_MIN_CONTRAST_MIN = SETTING_RANGES.terminalMinContrast.min
export const TERMINAL_MIN_CONTRAST_MAX = SETTING_RANGES.terminalMinContrast.max
export const TERMINAL_SCROLLBACK_LINES_MIN = SETTING_RANGES.scrollbackLines.min
export const TERMINAL_SCROLLBACK_LINES_MAX = SETTING_RANGES.scrollbackLines.max

// Nilai settings bisa diedit tangan dan datang lewat HTTP: hilang/NaN/'' harus mendarat di default,
// bukan di NaN — yang akan diterima xterm lalu dirender jadi grid bertinggi nol.
export function terminalFontSize(value: number): number {
  return clampSetting('fontSize', value, DEFAULT_SETTINGS.fontSize)
}

export function terminalLineHeight(value: number): number {
  return clampSetting('terminalLineHeight', value, DEFAULT_SETTINGS.terminalLineHeight)
}

export function terminalLetterSpacing(value: number): number {
  return clampSetting('terminalLetterSpacing', value, DEFAULT_SETTINGS.terminalLetterSpacing)
}

/** Bobot font; `fallback` beda untuk normal (400) dan bold (700), jadi dua kunci tabel dipakai. */
export function terminalFontWeight(value: number, fallback: number, key: 'fontWeight' | 'fontWeightBold' = 'fontWeight'): number {
  return clampSetting(key, value, fallback)
}

export function terminalMinContrast(value: number): number {
  return clampSetting('terminalMinContrast', value, DEFAULT_SETTINGS.terminalMinContrast)
}

export function terminalScrollbackLines(value: number): number {
  return clampSetting('scrollbackLines', value, DEFAULT_SETTINGS.scrollbackLines)
}

/** Opsi turunan-appearance, sudah diresolve dan di-clamp. */
export interface XtermVisualOptions {
  fontFamily: string
  fontSize: number
  wordSeparator: string
  // xterm melebarkan dua ini ke `FontWeight` ('normal' | 'bold' | '100'… | number). Kita hanya
  // pernah MENULIS angka, tapi tipenya harus cocok dengan yang diekspos `term.options` atau target
  // live tidak bisa dibandingkan dengan terminal sungguhan.
  fontWeight: FontWeight
  fontWeightBold: FontWeight
  drawBoldTextInBrightColors: boolean
  minimumContrastRatio: number
  cursorBlink: boolean
  cursorStyle: TerminalCursorStyle
  /** Always `outline` (xterm's default): it shows at a glance which terminal on the canvas has focus. */
  cursorInactiveStyle: TerminalCursorStyle | 'outline' | 'none'
  lineHeight: number
  letterSpacing: number
  scrollback: number
  theme: ITheme
}

/** Slice `Settings` yang menentukan bagaimana terminal TERLIHAT. */
export type XtermVisualSettings = Pick<
  Settings,
  | 'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'fontWeightBold'
  | 'drawBoldTextInBrightColors'
  | 'terminalLineHeight'
  | 'terminalLetterSpacing'
  | 'terminalTheme'
  | 'terminalMinContrast'
  | 'terminalWordSeparator'
  | 'cursorStyle'
  | 'cursorBlink'
  // Bukan appearance, tapi satu-satunya kunci yang memberi xterm batas scrollback-nya (BARIS —
  // bukan `scrollbackBytes`, yang milik ring buffer PTY di server).
  | 'scrollbackLines'
>

/**
 * Setiap opsi appearance untuk `new Terminal({...})`, dari settings.
 *
 * `fontSizeOverride` adalah ukuran font per-terminal dari ⌘+/⌘− (`terminalFontZoomKeys`): ia
 * dilapis DI SINI, satu tempat, supaya jalur mount dan jalur live-apply membaca satu nilai lewat
 * satu fungsi dan tidak bisa berbeda.
 *
 * `allowProposedApi` dan `macOptionClickForcesSelection` ikut di sini meski bukan appearance,
 * supaya call site cukup menyebar hasil fungsi ini dan tidak ada literal opsi per-site yang bisa
 * menyimpang. `allowProposedApi` wajib: tanpanya `term.unicode.register` (Unicode 11) ditolak.
 */
export function xtermOptionsFromSettings(
  s: XtermVisualSettings,
  fontSizeOverride?: number,
): XtermVisualOptions & { allowProposedApi: true; macOptionClickForcesSelection: true } {
  return {
    fontFamily: s.fontFamily,
    fontSize: terminalFontSize(fontSizeOverride ?? s.fontSize),
    wordSeparator: s.terminalWordSeparator,
    fontWeight: terminalFontWeight(s.fontWeight, DEFAULT_SETTINGS.fontWeight),
    fontWeightBold: terminalFontWeight(s.fontWeightBold, DEFAULT_SETTINGS.fontWeightBold, 'fontWeightBold'),
    drawBoldTextInBrightColors: s.drawBoldTextInBrightColors,
    minimumContrastRatio: terminalMinContrast(s.terminalMinContrast),
    cursorBlink: s.cursorBlink,
    cursorStyle: s.cursorStyle,
    cursorInactiveStyle: 'outline',
    lineHeight: terminalLineHeight(s.terminalLineHeight),
    letterSpacing: terminalLetterSpacing(s.terminalLetterSpacing),
    scrollback: terminalScrollbackLines(s.scrollbackLines),
    theme: resolveTerminalTheme(s.terminalTheme).theme,
    allowProposedApi: true,
    // Di dalam app yang meminta mouse tracking (vim, htop) drag biasa diteruskan ke app;
    // Option/Alt memaksa seleksi (Shift melakukan hal sama lewat bypass xterm sendiri).
    macOptionClickForcesSelection: true,
  }
}

/** Cukup sepotong instance xterm untuk me-re-option-nya — menjaga file ini bisa dites tanpa DOM. */
export interface LiveOptionTarget {
  options: Partial<XtermVisualOptions>
}

/** Apa yang masih jadi utang caller setelah live re-option. */
export interface LiveOptionEffects {
  /**
   * GEOMETRI SEL berubah, jadi terminal ini sekarang memuat grid berbeda dan caller WAJIB
   * refit — melewatkan jalur yang sama dengan resize container, supaya PTY diberi tahu ukuran
   * barunya. Melewatkannya meninggalkan PTY berjalan di grid yang tidak dirender siapa pun, dan
   * TUI yang memosisikan kursor secara absolut akan menggambar di kolom yang salah.
   */
  metricsChanged: boolean
  /**
   * Palet berubah. xterm mengecat ulang sendiri, tapi caller memaksa satu refresh karena
   * swap renderer (WebGL → DOM) bisa menelan repaint penuh, dan palet yang setengah tercat
   * adalah kegagalan paling terlihat yang mungkin.
   */
  themeChanged: boolean
}

/**
 * Terapkan settings appearance ke terminal yang HIDUP, melaporkan apa yang masih jadi utang caller.
 *
 * Penugasan dilakukan per-opsi dan dijaga perbandingan, karena `options` xterm adalah proxy
 * setter: menulis nilai yang tidak berubah tetap memicu penanganan perubahannya (dan, untuk
 * `theme`, rebuild palet penuh). Terminal di-re-option pada setiap ketikan di settings, jadi guard
 * inilah yang menjaga tarikan slider tidak menggedor setiap terminal di canvas.
 *
 * Bobot font SENGAJA tidak ikut dalam `metricsChanged`: xterm menurunkan ukuran selnya dari
 * `CharSizeService`, yang hanya mengukur ulang pada `fontFamily`/`fontSize` — perubahan bobot tidak
 * pernah menggeser grid, jadi refit karenanya hanya melaporkan resize ke PTY untuk sia-sia.
 */
export function applyLiveOptions(
  term: LiveOptionTarget,
  s: XtermVisualSettings,
  fontSizeOverride?: number,
): LiveOptionEffects {
  const next = xtermOptionsFromSettings(s, fontSizeOverride)
  const o = term.options
  const metricsChanged =
    o.fontFamily !== next.fontFamily ||
    o.fontSize !== next.fontSize ||
    o.lineHeight !== next.lineHeight ||
    o.letterSpacing !== next.letterSpacing
  // Identitas, bukan kesetaraan mendalam: tema adalah konstanta modul, jadi id yang sama selalu
  // menghasilkan objek yang sama dan id yang berubah tidak pernah demikian.
  const themeChanged = o.theme !== next.theme

  if (o.fontFamily !== next.fontFamily) o.fontFamily = next.fontFamily
  if (o.fontSize !== next.fontSize) o.fontSize = next.fontSize
  if (o.wordSeparator !== next.wordSeparator) o.wordSeparator = next.wordSeparator
  if (o.lineHeight !== next.lineHeight) o.lineHeight = next.lineHeight
  if (o.letterSpacing !== next.letterSpacing) o.letterSpacing = next.letterSpacing
  if (o.fontWeight !== next.fontWeight) o.fontWeight = next.fontWeight
  if (o.fontWeightBold !== next.fontWeightBold) o.fontWeightBold = next.fontWeightBold
  if (o.drawBoldTextInBrightColors !== next.drawBoldTextInBrightColors) {
    o.drawBoldTextInBrightColors = next.drawBoldTextInBrightColors
  }
  if (o.minimumContrastRatio !== next.minimumContrastRatio) {
    o.minimumContrastRatio = next.minimumContrastRatio
  }
  if (o.cursorBlink !== next.cursorBlink) o.cursorBlink = next.cursorBlink
  if (o.cursorStyle !== next.cursorStyle) o.cursorStyle = next.cursorStyle
  if (o.scrollback !== next.scrollback) o.scrollback = next.scrollback
  if (themeChanged) o.theme = next.theme

  return { metricsChanged, themeChanged }
}
