import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = __dirname
const css = readFileSync(join(dir, 'sticky.font.css'), 'utf8')
// Real total is ~138 KB; the cap leaves headroom for a font bump but catches a full-family drop-in.
const MAX_WOFF2_BYTES = 200 * 1024

describe('sticky handwriting font', () => {
  const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1])

  it('references four local woff2 files that exist', () => {
    expect(urls).toHaveLength(4)
    for (const u of urls) {
      expect(u.startsWith('./')).toBe(true)
      expect(existsSync(join(dir, u))).toBe(true)
    }
  })

  it('ships the OFL license with the original copyright', () => {
    const ofl = readFileSync(join(dir, 'Caveat-OFL.txt'), 'utf8')
    expect(ofl).toContain('SIL Open Font License, Version 1.1')
    expect(ofl).toContain('Caveat Project Authors')
  })

  it('has no remote URLs or Google font hosts', () => {
    expect(css).not.toMatch(/https?:\/\//)
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
  })

  it('declares the sticky font stack and swap display', () => {
    expect(css).toContain("--sticky-font: 'Caveat'")
    expect(css.match(/font-display: swap/g)).toHaveLength(4)
  })

  it('keeps total woff2 size under the cap', () => {
    const total = readdirSync(dir)
      .filter((f) => f.endsWith('.woff2'))
      .reduce((n, f) => n + statSync(join(dir, f)).size, 0)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThan(MAX_WOFF2_BYTES)
  })
})
