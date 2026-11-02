// Minimap background on the dark canvas.
//
// React Flow ships `.react-flow__minimap { background: var(--xy-minimap-background-color-props,
// … #fff) }` in its own stylesheet, which loads after ours. A single-class override with the same
// specificity therefore loses the cascade and the dock renders white (QC B4). These guards pin the
// two things that make the dark canvas actually win: MORE specificity, and the custom property
// React Flow really reads. Pure text assertions: jsdom does not resolve `var()` in computed styles.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shell = readFileSync('src/client/styles.css', 'utf8')
const css = readFileSync('src/client/canvas-ui.css', 'utf8')
const app = readFileSync('src/client/App.tsx', 'utf8')

/** Body of the first rule whose selector is exactly `selector`. */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source)
  expect(match, `missing rule for ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

/** Class-selector specificity: every `.name` counts as one; ids/attrs are not used here. */
function specificity(selector: string): number {
  return (selector.match(/\./g) ?? []).length
}

describe('minimap dark override', () => {
  const override = '.react-flow .react-flow__minimap.minimap-dock'

  it('is more specific than React Flow and sets the variables React Flow reads', () => {
    expect(specificity(override)).toBeGreaterThan(specificity('.react-flow__minimap'))

    const body = ruleBody(css, override)
    expect(body).toContain('--xy-minimap-background-color-props: var(--vscode-minimap-background')
    expect(body).toContain('--xy-minimap-mask-background-color-props: var(--vscode-minimapSlider-background)')
  })

  it('tidak memakai !important dan tidak memasang maskColor inline dari App', () => {
    expect(css).not.toContain('!important')
    expect(app).not.toContain('maskColor')
  })

  it('keeps position on the base dock class, tanpa warna mentah atau background keras', () => {
    const base = ruleBody(shell, '.minimap-dock')
    expect(base).toContain('position: absolute')
    expect(base).toContain('margin: 0')
    expect(base).not.toContain('background')
    expect(base).not.toContain('border')
  })
})
