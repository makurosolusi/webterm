import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Source contract of the header modes (node env, no DOM): the three header heights, the Hidden overlay
// that must never take a click, reduced motion, and one source for web and native.
const src = (f: string): string => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')
const css = src('headerMode.css')
const base = src('styles.css')
const px = (css_: string, token: string): number => Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(css_)?.[1])
const block = (sheet: string, selector: string): string => {
  const at = sheet.indexOf(`${selector} {`)
  return at === -1 ? '' : sheet.slice(at, sheet.indexOf('}', at))
}

describe('--tabbar-h per mode: 70 / 35 / 0', () => {
  const title = px(base, '--title-bar-h')
  const tabs = px(base, '--editor-tabs-h')

  it('Full keeps the sum of both rows from styles.css', () => {
    expect([title, tabs]).toEqual([35, 35])
    expect(base).toContain('--tabbar-h: calc(var(--title-bar-h) + var(--editor-tabs-h))')
    expect(title + tabs).toBe(70)
  })

  it('Compact is one tab row; the title row is 0', () => {
    const rule = block(css, '.app-shell.app-shell--header-compact')
    expect(rule).toContain('--tabbar-h: var(--editor-tabs-h)')
    expect(rule).toContain('grid-template-rows: 0 var(--editor-tabs-h) minmax(0, 1fr) var(--status-bar-h)')
  })

  it('Hidden has no rows at all', () => {
    const rule = block(css, '.app-shell.app-shell--header-hidden')
    expect(rule).toContain('--tabbar-h: 0px')
    expect(rule).toContain('grid-template-rows: 0 0 minmax(0, 1fr) var(--status-bar-h)')
  })

  it('does not touch the row tokens the primitives read, so the revealed header keeps its height', () => {
    expect(css).not.toMatch(/--title-bar-h\s*:/)
    expect(css).not.toMatch(/--editor-tabs-h\s*:/)
  })
})

describe('Hidden overlay', () => {
  it('unrevealed rows are visibility:hidden (no click, no focus) and revealed ones show without moving layout', () => {
    const rows = block(css, '.app-shell--header-hidden > .app-titlebar')
    expect(rows).toContain('visibility: hidden')
    expect(rows).toContain('position: absolute')
    expect(block(css, ".app-shell--header-hidden > [data-revealed='true']")).toContain('visibility: visible')
  })

  it('has no element that can take a click: the edge hairline is pointer-events:none and nothing is position:fixed', () => {
    expect(block(css, '.app-shell--header-hidden::before')).toContain('pointer-events: none')
    expect(css).not.toContain('position: fixed')
    // the only generated box along the edge is that one hairline
    const generated = css.split('\n').filter((l) => /::(?:before|after)/.test(l)).map((l) => l.replace(/\s*[{,].*$/, ''))
    expect(generated).toEqual(['.app-shell--header-hidden::before', '.app-menu-button .vscode-menu-bar__item::before', 'body.clean-view .app-shell--header-hidden::before'])
  })

  it('reduced motion turns the slide off', () => {
    const media = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(media).toContain('transition: none')
  })

  it('clean view still hides everything, hairline included', () => {
    expect(css).toContain('body.clean-view .app-shell--header-hidden::before { display: none; }')
    expect(base).toContain('body.clean-view .app-shell {')
  })
})

describe('tokens and one source', () => {
  it('uses theme tokens only: no hex colors', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('no header-mode file branches on native or reads a native flag (web and native share one UI)', () => {
    for (const f of ['headerMode.store.ts', 'headerMode.commands.ts', 'headerMode.notice.ts', 'headerMode.css', 'useHeaderReveal.ts', 'AppMenuButton.tsx', 'SettingsHeaderMode.tsx']) {
      expect(src(f), f).not.toMatch(/electrobun|isNative|nativeApp|-webkit-app-region/i)
    }
  })

  it('the reveal hook creates no DOM element', () => {
    const hook = src('useHeaderReveal.ts')
    expect(hook).not.toMatch(/createElement|appendChild|insertAdjacent|createPortal/)
  })
})
