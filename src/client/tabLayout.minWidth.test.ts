import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(`${process.cwd()}/src/client/tab-layout.css`, 'utf8')
const rule = (sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)![1]
const px = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(rule('.tabs-strip'))![1])

// VS Code "fit" tab sizing: content width clamped to 80-240px, never stretched to a fixed basis.
describe('tab strip sizing', () => {
  it('.tabs-tab sizes to its content between --tabs-tab-min-width and --tabs-tab-max-width', () => {
    const tab = rule('.tabs-tab')
    expect(tab).toMatch(/flex:\s*0 0 auto/)
    expect(tab).toMatch(/min-width:\s*var\(--tabs-tab-min-width\)/)
    expect(tab).toMatch(/max-width:\s*var\(--tabs-tab-max-width\)/)
    expect(px('tabs-tab-min-width')).toBe(80)
    expect(px('tabs-tab-max-width')).toBe(240)
  })

  it('the label ellipsizes inside the max width', () => {
    expect(rule('.tabs-tab__title')).toMatch(/text-overflow:\s*ellipsis/)
  })
})
