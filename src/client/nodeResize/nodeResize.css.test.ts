// Cascade policy for the invisible edge-resize strips. @xyflow/react's stylesheet is imported by App.tsx
// after styles.css (which pulls in node-chrome.css), so on a specificity tie the library's solid blue
// handle background wins. Our invisible rules must out-rank the library's, whatever the import order.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Rule { selector: string; body: string }

const rules = (css: string): Rule[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, sel, body]) =>
    sel.split(',').map((s) => ({ selector: s.trim(), body })))

/** Class + pseudo-class count; neither sheet uses ids or element selectors on these controls. */
const specificity = (selector: string): number => (selector.match(/[.:][\w-]+/g) ?? []).length

const ours = rules(readFileSync(fileURLToPath(new URL('../node-chrome.css', import.meta.url)), 'utf8'))
const xyflow = rules(readFileSync(createRequire(import.meta.url).resolve('@xyflow/react/dist/style.css'), 'utf8'))

/** Highest specificity among the library rules for `part` that paint `prop`. */
const libraryRank = (part: 'handle' | 'line', prop: RegExp): number => {
  const hits = xyflow.filter((r) => r.selector.includes('.react-flow__resize-control') && r.selector.includes(`.${part}`) && prop.test(r.body))
  expect(hits.length).toBeGreaterThan(0)
  return Math.max(...hits.map((r) => specificity(r.selector)))
}

/** Our resting (non-hover) invisible rules for `part`. */
const invisible = (part: 'handle' | 'line'): Rule[] =>
  ours.filter((r) => r.selector.includes('.node-edge-resize') && r.selector.includes(`.${part}`) && !r.selector.includes(':hover'))

describe('edge-resize strips stay invisible against @xyflow/react\'s sheet', () => {
  it('corner handles: transparent background and no border, out-ranking the library\'s blue squares', () => {
    const rank = libraryRank('handle', /background/)
    const bg = invisible('handle').filter((r) => /background(-color)?:\s*transparent/.test(r.body))
    expect(bg.length).toBeGreaterThan(0)
    for (const r of bg) expect(specificity(r.selector)).toBeGreaterThan(rank)
    const border = invisible('handle').filter((r) => /border:\s*none/.test(r.body))
    expect(border.length).toBeGreaterThan(0)
    for (const r of border) expect(specificity(r.selector)).toBeGreaterThan(libraryRank('handle', /border:/))
  })

  it('edge lines: transparent border colour and background, out-ranking the library\'s line colour', () => {
    const rank = libraryRank('line', /border-color/)
    const line = invisible('line').filter((r) => /border-color:\s*transparent/.test(r.body) && /background:\s*transparent/.test(r.body))
    expect(line.length).toBeGreaterThan(0)
    for (const r of line) expect(specificity(r.selector)).toBeGreaterThan(rank)
  })

  it('edges and corners show only a hover highlight', () => {
    for (const part of ['line', 'handle']) {
      expect(ours.some((r) => r.selector.includes(`.${part}.node-edge-resize:hover`) && /background:\s*var\(--vscode-sash-hoverBorder/.test(r.body))).toBe(true)
    }
  })

  it('needs no !important (specificity is enough; NodeLayoutResizer never passes `color` to the strips)', () => {
    for (const r of ours.filter((r) => r.selector.includes('.node-edge-resize'))) expect(r.body).not.toContain('!important')
  })
})
