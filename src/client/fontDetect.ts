// Which terminal fonts are installed on THIS computer, so the Font family list only offers fonts that
// render. `document.fonts.check()` cannot answer it: it reports true for any font that is not a web
// font, installed or not. The standard way is measuring: a font that is present draws a test string
// at a width different from the generic fallback it would otherwise use.
const SAMPLE = 'mmmmmmmmmmlli10OO@#'
const SIZE = '72px'
const BASES = ['monospace', 'serif', 'sans-serif'] as const

let ctx: CanvasRenderingContext2D | null | undefined

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx
  try {
    ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  } catch {
    ctx = null // jsdom and locked-down browsers have no 2D canvas
  }
  return ctx
}

const width = (c: CanvasRenderingContext2D, font: string): number => {
  c.font = `${SIZE} ${font}`
  return c.measureText(SAMPLE).width
}

/** First family of a CSS font list, unquoted (`"SF Mono", Menlo` -> `SF Mono`). */
export const firstFamily = (list: string): string => list.split(',')[0].trim().replace(/^["']|["']$/g, '')

/**
 * Is `family` installed? Generic families always are. Without a canvas there is no way to measure,
 * so every font counts as installed (the list then shows all presets, as before).
 */
export function isFontInstalled(family: string): boolean {
  if (/^(monospace|serif|sans-serif|ui-monospace|system-ui)$/i.test(family)) return true
  const c = context()
  if (!c) return true
  return BASES.some((base) => width(c, `"${family}", ${base}`) !== width(c, base))
}

/** The family of a CSS font list that actually renders: the first installed one (`monospace` at worst). */
export function renderedFamily(list: string): string {
  return list.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).find(isFontInstalled) ?? 'monospace'
}

/** Forget the cached canvas (tests swap the canvas mock). */
export function resetFontDetect(): void {
  ctx = undefined
}
