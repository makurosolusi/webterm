// Pure facts about a rail workspace tile: its monogram, and the ink rule the stylesheet applies.

/** Id of the canvas region a workspace tile controls (`.app-main` in App). */
export const WORKSPACE_CANVAS_ID = 'workspace-canvas'

/** Fallback glyph for a workspace whose name has no visible character. */
export const MONOGRAM_FALLBACK = '?'

/**
 * OKLCH lightness above which a tile's monogram is black instead of white. `workspaceRail.css` writes
 * the same number into its `oklch(from ...)` rule; `workspaceTiles.test.ts` re-derives the ink for all
 * 36 tokens x 2 themes from that stylesheet and requires 3:1 (large text, WCAG 1.4.3), so a palette
 * change that breaks the rule fails there. Any value in 0.60-0.65 satisfies every current token.
 */
export const TILE_INK_LIGHTNESS_CUTOFF = 0.62

/** First user-perceived character of the name, upper-cased (graphemes, so an emoji or accent stays whole). */
export function monogram(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return MONOGRAM_FALLBACK
  const first = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment
    : Array.from(trimmed)[0]
  return (first ?? MONOGRAM_FALLBACK).toLocaleUpperCase()
}
