// Palette policy for workspace colors: every hue x shade token exists in both themes and holds >= 3:1
// (WCAG 1.4.11) against the worst tab/status surface of that theme; no component hardcodes a hue.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKSPACE_HUES, WORKSPACE_SHADES } from '../shared/workspaceColor'

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'workspaceColor.css'), 'utf8')
const [darkBlock, lightBlock] = css.split(":root[data-theme='light']")
const DARK_SURFACE = '#2d2d2d'
const LIGHT_SURFACE = '#ececec'
const MIN_CONTRAST = 3

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const token = (block: string, name: string): string | null => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? null

describe('workspace color palette', () => {
  for (const [theme, block, surface] of [['dark', darkBlock, DARK_SURFACE], ['light', lightBlock, LIGHT_SURFACE]] as const) {
    it(`defines all 36 tokens in the ${theme} theme with enough contrast`, () => {
      const weak: string[] = []
      for (const hue of WORKSPACE_HUES) for (const shade of WORKSPACE_SHADES) {
        const value = token(block, `ws-${hue}-${shade}`)
        if (!value) weak.push(`${hue}-${shade}: missing`)
        else if (contrast(value, surface) < MIN_CONTRAST) weak.push(`${hue}-${shade}: ${value}`)
      }
      expect(weak).toEqual([])
    })
  }
  it('gives each hue three distinct shades', () => {
    for (const hue of WORKSPACE_HUES) {
      expect(new Set(WORKSPACE_SHADES.map((s) => token(darkBlock, `ws-${hue}-${s}`))).size, hue).toBe(3)
    }
  })
})
