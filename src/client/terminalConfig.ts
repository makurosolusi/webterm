import type { FontWeight, ITheme } from '@xterm/xterm'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { clampSetting, SETTING_RANGES } from '../shared/settings.ranges'
import type { Settings, TerminalCursorStyle } from '../shared/settings'
import { resolveTerminalTheme } from './themes'

/**
 * Pure decisions behind the xterm instance in `TerminalCore`: which `ITerminalOptions` a set of
 * settings produces, and how to apply a settings change to a terminal that is already running.
 * Kept free of DOM and xterm runtime imports so the node-env test runner can exercise it.
 *
 * One source feeds both paths (`new Terminal({...})` and live updates) so an option cannot be
 * wired into only one of them. Option semantics follow the xterm.js `ITerminalOptions` reference.
 */

// The ranges live in `settings.ranges.ts`; these names stay as aliases for existing consumers.
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

// Settings can be hand-edited or arrive over HTTP. A missing, NaN or '' value must land on the
// default: xterm accepts NaN silently and renders a zero-height grid.
export const terminalFontSize = (value: number): number =>
  clampSetting('fontSize', value, DEFAULT_SETTINGS.fontSize)

export const terminalLineHeight = (value: number): number =>
  clampSetting('terminalLineHeight', value, DEFAULT_SETTINGS.terminalLineHeight)

export const terminalLetterSpacing = (value: number): number =>
  clampSetting('terminalLetterSpacing', value, DEFAULT_SETTINGS.terminalLetterSpacing)

/** Clamp a font weight; regular and bold have different fallbacks, hence the explicit `key`. */
export function terminalFontWeight(
  value: number,
  fallback: number,
  key: 'fontWeight' | 'fontWeightBold' = 'fontWeight',
): number {
  return clampSetting(key, value, fallback)
}

export const terminalMinContrast = (value: number): number =>
  clampSetting('terminalMinContrast', value, DEFAULT_SETTINGS.terminalMinContrast)

export const terminalScrollbackLines = (value: number): number =>
  clampSetting('scrollbackLines', value, DEFAULT_SETTINGS.scrollbackLines)

/** The resolved, clamped options that decide how a terminal looks. */
export interface XtermVisualOptions {
  fontFamily: string
  fontSize: number
  wordSeparator: string
  // xterm widens the weight options to `FontWeight`; only numbers are ever written, but the type
  // must match what `term.options` exposes or a real terminal can't be used as a live target.
  fontWeight: FontWeight
  fontWeightBold: FontWeight
  drawBoldTextInBrightColors: boolean
  minimumContrastRatio: number
  cursorBlink: boolean
  cursorStyle: TerminalCursorStyle
  /** Always `outline` (xterm's default): it shows which terminal on the canvas has focus. */
  cursorInactiveStyle: TerminalCursorStyle | 'outline' | 'none'
  lineHeight: number
  letterSpacing: number
  scrollback: number
  theme: ITheme
}

/** The slice of `Settings` that determines how a terminal looks. */
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
  // Not visual, but the only key that tells xterm its scrollback limit in LINES (not
  // `scrollbackBytes`, which sizes the server-side PTY ring buffer).
  | 'scrollbackLines'
>

/** Option keys written when applying settings to a running terminal, in write order. */
const LIVE_KEYS = [
  'fontFamily',
  'fontSize',
  'wordSeparator',
  'lineHeight',
  'letterSpacing',
  'fontWeight',
  'fontWeightBold',
  'drawBoldTextInBrightColors',
  'minimumContrastRatio',
  'cursorBlink',
  'cursorStyle',
  'scrollback',
  'theme',
] as const satisfies readonly (keyof XtermVisualOptions)[]

/** Keys whose change alters the cell grid (font weight does not: see `applyLiveOptions`). */
const GEOMETRY_KEYS = ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing'] as const

/**
 * All options for `new Terminal({...})`, derived from settings.
 *
 * `fontSizeOverride` is the per-terminal size from the zoom shortcuts; it is layered in here so the
 * mount path and the live path read one value through one function. `allowProposedApi` (needed for
 * `term.unicode.register`) and `macOptionClickForcesSelection` (Option-drag selects even while an
 * app has mouse tracking on) are not visual, but live here so call sites just spread the result.
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
    macOptionClickForcesSelection: true,
  }
}

/** The slice of an xterm instance needed to re-option it; keeps this file testable without a DOM. */
export interface LiveOptionTarget {
  options: Partial<XtermVisualOptions>
}

/** What the caller still owes after a live re-option. */
export interface LiveOptionEffects {
  /** Cell geometry changed: the caller MUST refit so the PTY learns the new grid size. */
  metricsChanged: boolean
  /** Palette changed: the caller should force one refresh, since a renderer swap can swallow the repaint. */
  themeChanged: boolean
}

/**
 * Apply settings to a RUNNING terminal and report what the caller still owes.
 *
 * Writes are per option and guarded by comparison: `term.options` is a setter proxy, so writing an
 * unchanged value still triggers xterm's change handling (a full palette rebuild for `theme`), and
 * settings sliders re-option every terminal on every tick.
 *
 * Font weight is deliberately not geometry: xterm re-measures cells only on family/size changes, so
 * refitting for a weight change would just send the PTY a pointless resize.
 */
export function applyLiveOptions(
  term: LiveOptionTarget,
  s: XtermVisualSettings,
  fontSizeOverride?: number,
): LiveOptionEffects {
  const next = xtermOptionsFromSettings(s, fontSizeOverride)
  const current = term.options as Record<string, unknown>
  const wanted: Record<string, unknown> = { ...next }
  const changed = new Set<string>(LIVE_KEYS.filter((k) => current[k] !== wanted[k]))
  for (const key of LIVE_KEYS) if (changed.has(key)) current[key] = wanted[key]
  return {
    metricsChanged: GEOMETRY_KEYS.some((k) => changed.has(k)),
    // Identity compare: a theme is a module constant, so one id always yields the same object.
    themeChanged: changed.has('theme'),
  }
}
