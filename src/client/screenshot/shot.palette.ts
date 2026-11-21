// Named presets for the annotator toolbar and the renderer. Red first: LightShot's default.

export interface ShotColor { name: string; value: string }

/** Preset colors (hex, so render can derive a contrasting text background). */
export const SHOT_COLORS: readonly ShotColor[] = [
  { name: 'Red', value: '#ff2d2d' },
  { name: 'Orange', value: '#ff9500' },
  { name: 'Yellow', value: '#ffd60a' },
  { name: 'Green', value: '#30d158' },
  { name: 'Blue', value: '#0a84ff' },
  { name: 'Purple', value: '#bf5af2' },
  { name: 'White', value: '#ffffff' },
  { name: 'Black', value: '#000000' },
]
/** Color selected on first use. */
export const DEFAULT_COLOR = SHOT_COLORS[0].value
/** Marker starts yellow like a highlighter (red at this width is too heavy); other tools keep DEFAULT_COLOR. */
export const MARKER_DEFAULT_COLOR = SHOT_COLORS[2].value
/** Stroke width presets in image pixels (thin, medium, thick). */
export const SHOT_WIDTHS: readonly number[] = [2, 4, 8]
/** Stroke width selected on first use. */
export const DEFAULT_WIDTH = SHOT_WIDTHS[1]
/** Text size presets in image pixels. */
export const SHOT_TEXT_SIZES: readonly number[] = [16, 24, 36]
/** Text size selected on first use. */
export const DEFAULT_TEXT_SIZE = SHOT_TEXT_SIZES[1]
/** Marker strokes are this many times thicker than the chosen width. */
export const MARKER_WIDTH_FACTOR = 4
/** Marker opacity for plain source-over: text underneath stays readable, and the stroke shows on dark and light backgrounds. */
export const MARKER_ALPHA = 0.4
/** Arrow head length in stroke widths, with a floor so thin arrows keep a visible head. */
export const ARROW_HEAD_FACTOR = 4
export const ARROW_HEAD_MIN_PX = 12
/** Half-angle of the arrow head. */
export const ARROW_HEAD_ANGLE = Math.PI / 7
/** System UI font stack for text shapes. */
export const SHOT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
/** Padding around text when it has a contrast background. */
export const TEXT_BG_PADDING_PX = 4
/** Line height as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25
