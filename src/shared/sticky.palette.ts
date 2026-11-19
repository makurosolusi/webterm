// Sticky note palette: the ten pastel paper colors, defaults and a pure contrast helper. Shared by the
// server sanitizer (workspace.shape.ts) and the client; no imports so it can never form a cycle.

/** Fixed order: top row left to right, then bottom row. */
export const STICKY_COLORS = [
  { id: 'salmon', hex: '#F3A99C' }, { id: 'orange', hex: '#F6C46E' }, { id: 'gold', hex: '#F8D86A' },
  { id: 'lemon', hex: '#FBF39A' }, { id: 'green', hex: '#86E0A0' },
  { id: 'gray', hex: '#E4E4E4' }, { id: 'pink', hex: '#F4BDEE' }, { id: 'violet', hex: '#D9BEFA' },
  { id: 'blue', hex: '#84CBFA' }, { id: 'cyan', hex: '#78DCEF' },
] as const

export type StickyColorId = (typeof STICKY_COLORS)[number]['id']

export const DEFAULT_STICKY_COLOR: StickyColorId = 'lemon'
/** Text color on every sticky: dark ink like paper, identical in light and dark themes. */
export const STICKY_INK = '#1C1C1C'
export const STICKY_DEFAULT_SIZE = { width: 180, height: 180 } as const
export const STICKY_MIN_SIZE = { width: 120, height: 120 } as const
export const STICKY_TEXT_MAX = 2000
export const STICKY_TAG_MAX = 24

export const isStickyKind = (kind: unknown): kind is 'sticky' => kind === 'sticky'

export const isStickyColor = (v: unknown): v is StickyColorId => STICKY_COLORS.some((c) => c.id === v)

/** A palette id, or the default for anything else (unknown id, wrong type, absent). */
export const normalizeStickyColor = (v: unknown): StickyColorId => (isStickyColor(v) ? v : DEFAULT_STICKY_COLOR)

/** Hex of a palette id (unknown -> default color). */
export const stickyHex = (v: unknown): string => STICKY_COLORS.find((c) => c.id === normalizeStickyColor(v))!.hex

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio of the sticky ink against `bgHex` (#RRGGBB). */
export function stickyInkContrast(bgHex: string): number {
  const [a, b] = [luminance(STICKY_INK), luminance(bgHex)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Text of a sticky: string only, capped, no control characters except newline/tab. */
export const cleanStickyText = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, STICKY_TEXT_MAX) : ''

/** Tag of a sticky: one line (whitespace runs collapse), trimmed, capped. */
export const cleanStickyTag = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, STICKY_TAG_MAX) : ''
