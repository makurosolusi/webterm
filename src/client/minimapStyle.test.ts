// Minimap background on the dark canvas.
//
// React Flow ships `.react-flow__minimap { background: var(--xy-minimap-background-color-props,
// … #fff) }` in its own stylesheet, which loads after ours. A single-class override with the same
// specificity therefore loses the cascade and the dock renders white (QC B4). These guards pin the
// two things that make the dark canvas actually win: MORE specificity, and the custom property
// React Flow really reads. Pure text assertions: jsdom does not resolve `var()` in computed styles.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/styles.css', 'utf8')

/** Body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  expect(match, `missing rule for ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

/** Class-selector specificity: every `.name` counts as one; ids/attrs are not used here. */
function specificity(selector: string): number {
  return (selector.match(/\./g) ?? []).length
}

describe('minimap dark override', () => {
  it('is more specific than React Flow and sets the variable React Flow reads', () => {
    const override = '.react-flow__minimap.minimap-dock'
    expect(specificity(override)).toBeGreaterThan(specificity('.react-flow__minimap'))

    const body = ruleBody(override)
    expect(body).toContain('--xy-minimap-background-color-props: var(--canvas-bg)')
    expect(body).toContain('background: var(--canvas-bg)')
  })

  it('keeps position and border on the base dock class', () => {
    const base = ruleBody('.minimap-dock')
    expect(base).toContain('position: absolute')
    expect(base).toContain('border: 1px solid var(--border)')
    expect(base).toContain('background: var(--canvas-bg)')
  })

  it('declares the override after the base rule', () => {
    expect(css.indexOf('.react-flow__minimap.minimap-dock')).toBeGreaterThan(
      css.indexOf('.minimap-dock {')
    )
  })
})
