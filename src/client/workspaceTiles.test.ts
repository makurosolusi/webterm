// Tile monogram and the ink contrast contract: for each of the 36 workspace tokens in both themes, the
// ink that `workspaceRail.css` picks (black above OKLCH L 0.62, else white) holds 3:1 on the fill (large
// text, WCAG 1.4.3). The test re-implements the stylesheet's rule, so a palette edit that breaks it fails here.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKSPACE_HUES, WORKSPACE_SHADES } from '../shared/workspaceColor'
import { MONOGRAM_FALLBACK, TILE_INK_LIGHTNESS_CUTOFF, monogram } from './workspaceTiles'

const dir = path.dirname(fileURLToPath(import.meta.url))
const colors = readFileSync(path.join(dir, 'workspaceColor.css'), 'utf8')
const rail = readFileSync(path.join(dir, 'workspaceRail.css'), 'utf8')
const [darkBlock, lightBlock] = colors.split(":root[data-theme='light']")
const LARGE_TEXT_CONTRAST = 3

const channel = (hex: string, i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255
const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string): number => 0.2126 * linear(channel(hex, 1)) + 0.7152 * linear(channel(hex, 3)) + 0.0722 * linear(channel(hex, 5))
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
/** OKLab lightness of an sRGB hex (Bjorn Ottosson's reference matrices). */
function oklabL(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => linear(channel(hex, i)))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}
const token = (block: string, name: string): string | null => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? null

describe('monogram', () => {
  it('is the first character, upper-cased', () => {
    expect(monogram('webterm')).toBe('W')
    expect(monogram('  api')).toBe('A')
  })
  it('keeps a whole grapheme (accent, emoji) and falls back for an empty name', () => {
    expect(monogram('émile')).toBe('É')
    expect(monogram('🚀 launch')).toBe('🚀')
    expect(monogram('   ')).toBe(MONOGRAM_FALLBACK)
    expect(monogram('')).toBe(MONOGRAM_FALLBACK)
  })
})

describe('tile ink contrast: 36 tokens x 2 themes', () => {
  it('the stylesheet uses the exported cutoff', () => {
    expect(rail).toContain(`(l - ${TILE_INK_LIGHTNESS_CUTOFF}) * -1000`)
  })
  for (const [theme, block] of [['dark', darkBlock], ['light', lightBlock]] as const) {
    it(`every ${theme} token keeps >= 3:1 between fill and ink`, () => {
      const weak: string[] = []
      let checked = 0
      for (const hue of WORKSPACE_HUES) for (const shade of WORKSPACE_SHADES) {
        const fill = token(block, `ws-${hue}-${shade}`)
        if (!fill) { weak.push(`${hue}-${shade}: missing`); continue }
        checked += 1
        const ink = oklabL(fill) > TILE_INK_LIGHTNESS_CUTOFF ? 0 : 1
        const ratio = contrast(luminance(fill), ink)
        if (ratio < LARGE_TEXT_CONTRAST) weak.push(`${hue}-${shade} ${fill}: ${ratio.toFixed(2)}`)
      }
      expect(checked).toBe(36)
      expect(weak).toEqual([])
    })
  }
})
