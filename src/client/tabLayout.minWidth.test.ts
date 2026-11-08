import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(`${process.cwd()}/src/client/tab-layout.css`, 'utf8')
const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)![1]

// Icon 16 + padding 12 + ~60px name + dot 8 + close 20 + gaps: below this a node name turns into "D…".
const READABLE_MIN_PX = 112

describe('tab strip minimum width', () => {
  it('.tabs-tab min-width resolves via --tabs-tab-min-width to a readable px floor', () => {
    expect(rule('.tabs-tab')).toMatch(/min-width:\s*var\(--tabs-tab-min-width\)/)
    const px = Number(/--tabs-tab-min-width:\s*(\d+)px/.exec(rule('.tabs-strip'))![1])
    expect(px).toBeGreaterThanOrEqual(READABLE_MIN_PX)
    expect(px).not.toBe(72)
  })
})
