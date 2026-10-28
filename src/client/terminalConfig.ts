import type { FontWeight, ITheme } from '@xterm/xterm'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type {
  Settings,
  TerminalCursorInactiveStyle,
  TerminalCursorStyle,
} from '../shared/settings'
import { resolveTerminalTheme } from './themes'

/**
 * Keputusan murni di balik instance xterm di `TerminalCore` — port dari nodeterm
 * `src/renderer/terminal/terminal-config.ts`, dipersempit ke bagian APPEARANCE-nya.
 *
 * Diekstrak ke modul sendiri supaya bisa dites tanpa harness xterm/DOM: vitest webterm jalan di
 * environment node, tidak ada jsdom. Yang TIDAK diport dari nodeterm: seluruh mesin co-attach
 * (`reportedSize`, letterbox, `TermSize`), seeding tmux (`attachReplay`, `seedPaint`,
 * `repaintResync`, OSC 52), park/adopt, dan tema "glass" — webterm tidak punya tmux, tidak punya
 * satu-pty-N-subscriber, dan tidak punya latar translusen di balik terminal.
 *
 * Satu sumber untuk DUA jalur: opsi saat `new Terminal({...})` (`xtermOptionsFromSettings`) dan
 * perubahan ke terminal yang sudah hidup (`applyLiveOptions`), supaya opsi baru tidak bisa
 * mendarat di satu jalur saja.
 */

/** Tinggi baris sebagai kelipatan ukuran font. Di bawah 1 xterm memotong descender glyph; di atas
 *  2 grid-nya sebagian besar udara dan TUI layar-penuh berhenti memuat apa pun yang berguna. */
export const TERMINAL_LINE_HEIGHT_MIN = 1
export const TERMINAL_LINE_HEIGHT_MAX = 2
/** Px ekstra antar sel. Negatif merapatkan; melewati batas ini karakter box-drawing (yang dipakai
 *  CLI agent menggambar rangkanya) berhenti bertemu dan output tampak tercabik. */
export const TERMINAL_LETTER_SPACING_MIN = -2
export const TERMINAL_LETTER_SPACING_MAX = 4
/** Bobot font numerik CSS. */
export const TERMINAL_FONT_WEIGHT_MIN = 100
export const TERMINAL_FONT_WEIGHT_MAX = 900
/** Batas kontras xterm sendiri: 1 mematikan penyesuaian, 21 memaksa hitam-di-atas-putih. */
export const TERMINAL_MIN_CONTRAST_MIN = 1
export const TERMINAL_MIN_CONTRAST_MAX = 21
/** Baris scrollback xterm (`settings.scrollbackLines`). Di bawah batas bawah ini satu `clear` saja
 *  sudah membuang output yang baru lewat; di atas batas atas biayanya nyata — xterm mengalokasikan
 *  `cols × 12 B` untuk SETIAP baris yang di-buffer, per node, dan satu canvas memuat banyak node. */
export const TERMINAL_SCROLLBACK_LINES_MIN = 1_000
export const TERMINAL_SCROLLBACK_LINES_MAX = 100_000

function clamp(value: number, min: number, max: number, fallback: number): number {
  // Nilai settings bisa diedit tangan dan datang lewat HTTP: nilai hilang/NaN harus mendarat di
  // default, bukan di NaN — yang akan diterima xterm dengan senang hati lalu dirender jadi grid
  // bertinggi nol.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(min, value), max)
}

export function terminalLineHeight(value: number): number {
  return clamp(value, TERMINAL_LINE_HEIGHT_MIN, TERMINAL_LINE_HEIGHT_MAX, 1)
}

export function terminalLetterSpacing(value: number): number {
  return clamp(value, TERMINAL_LETTER_SPACING_MIN, TERMINAL_LETTER_SPACING_MAX, 0)
}

export function terminalFontWeight(value: number, fallback: number): number {
  return clamp(value, TERMINAL_FONT_WEIGHT_MIN, TERMINAL_FONT_WEIGHT_MAX, fallback)
}

export function terminalMinContrast(value: number): number {
  return clamp(value, TERMINAL_MIN_CONTRAST_MIN, TERMINAL_MIN_CONTRAST_MAX, 1)
}

export function terminalScrollbackLines(value: number): number {
  return clamp(
    value,
    TERMINAL_SCROLLBACK_LINES_MIN,
    TERMINAL_SCROLLBACK_LINES_MAX,
    DEFAULT_SETTINGS.scrollbackLines,
  )
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
  cursorInactiveStyle: TerminalCursorInactiveStyle
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
  | 'cursorInactiveStyle'
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
    fontSize: fontSizeOverride ?? s.fontSize,
    wordSeparator: s.terminalWordSeparator,
    fontWeight: terminalFontWeight(s.fontWeight, 400),
    fontWeightBold: terminalFontWeight(s.fontWeightBold, 700),
    drawBoldTextInBrightColors: s.drawBoldTextInBrightColors,
    minimumContrastRatio: terminalMinContrast(s.terminalMinContrast),
    cursorBlink: s.cursorBlink,
    cursorStyle: s.cursorStyle,
    cursorInactiveStyle: s.cursorInactiveStyle,
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
  if (o.cursorInactiveStyle !== next.cursorInactiveStyle) {
    o.cursorInactiveStyle = next.cursorInactiveStyle
  }
  if (o.scrollback !== next.scrollback) o.scrollback = next.scrollback
  if (themeChanged) o.theme = next.theme

  return { metricsChanged, themeChanged }
}
