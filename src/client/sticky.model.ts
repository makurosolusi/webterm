// Pure sticky-note logic: text auto-fit, the decorative tilt and the one-line row label. No DOM, no React.
import { STICKY_DEFAULT_SIZE, STICKY_TEXT_MAX } from '../shared/sticky.palette'
import { STICKY_TEXT } from './sticky.labels'

/** Font sizes in px at the default 180 box; the max scales with the box so a big note gets big writing. */
export const STICKY_FONT_MIN = 16
const FONT_MAX_AT_DEFAULT = 44
const FONT_STEP = 2
/** Average Caveat glyph width and line height as multiples of the font size (estimated, tuned from use). */
const GLYPH_EM = 0.42
const LINE_EM = 1.08
/** Padding of the writing area (matches sticky.css) and the strip kept clear for the corner label. */
const PAD = 14
const TAG_BAND = 18
/** Word wrapping wastes some of each line; this pads the estimate instead of measuring the DOM. */
const WRAP_SLACK = 1.12

const lineCount = (text: string, perLine: number): number =>
  text.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil((p.length * WRAP_SLACK) / perLine)), 0)

const fits = (text: string, font: number, w: number, h: number): boolean => {
  const perLine = Math.max(1, Math.floor((w - 2 * PAD) / (font * GLYPH_EM)))
  return lineCount(text, perLine) * font * LINE_EM <= h - 2 * PAD - TAG_BAND
}

/** Largest font (stepping down) at which `text` fits the box; the minimum when nothing fits (the note then scrolls). */
export function stickyFontSize(text: string, width: number, height: number): number {
  const max = Math.round(Math.max(STICKY_FONT_MIN, (FONT_MAX_AT_DEFAULT * Math.min(width, height)) / STICKY_DEFAULT_SIZE.width))
  for (let f = max; f > STICKY_FONT_MIN; f -= FONT_STEP) if (fits(text, f, width, height)) return f
  return STICKY_FONT_MIN
}

/** True when even the smallest font does not fit: the note scrolls instead of shrinking further. */
export const stickyOverflows = (text: string, width: number, height: number): boolean => !fits(text, STICKY_FONT_MIN, width, height)

/** Tilt in degrees, -2.5..2.5 in half-degree steps, stable per node id (never stored). */
export function stickyTilt(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return ((h % 11) - 5) / 2
}

const MAX_ROW_LABEL = 40

/** First non-empty line of a note, capped for list rows; the kind name when the note is empty. */
export function stickyRowLabel(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean)
  return line ? line.slice(0, MAX_ROW_LABEL) : STICKY_TEXT.kind
}

/** The character counter shows from 90% of the text budget, so the cap never surprises the writer. */
export const stickyCounterVisible = (len: number): boolean => len >= STICKY_TEXT_MAX * 0.9
