import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Source contract of the header modes (node env, no DOM): Tabs = one 35px row, Hidden = no row, the Hidden overlay
// that must never take a click, reduced motion, and one source for web and native.
const src = (f: string): string => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')
const css = src('headerMode.css')
const base = src('styles.css')
const px = (css_: string, token: string): number => Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(css_)?.[1])
const block = (sheet: string, selector: string): string => {
  const at = sheet.indexOf(`${selector} {`)
  return at === -1 ? '' : sheet.slice(at, sheet.indexOf('}', at))
}

describe('--tabbar-h per mode: 35 / 0 (there is no 70px header any more)', () => {
  it('Tabs is the base grid: one row, `--tabbar-h` is that row', () => {
    expect(px(base, '--editor-tabs-h')).toBe(35)
    expect(base).toContain('--tabbar-h: var(--editor-tabs-h)')
    expect(base).not.toContain('--title-bar-h')
    expect(block(base, '.app-shell')).toContain('grid-template-rows: var(--editor-tabs-h) minmax(0, 1fr) var(--status-bar-h)')
    expect(css).not.toContain('app-shell--header-tabs') // the default needs no override
    expect(css).not.toContain('app-shell--header-compact')
    expect(css).not.toContain('app-shell--header-full')
  })

  it('Hidden has no rows at all', () => {
    const rule = block(css, '.app-shell.app-shell--header-hidden')
    expect(rule).toContain('--tabbar-h: 0px')
    expect(rule).toContain('grid-template-rows: 0 minmax(0, 1fr) var(--status-bar-h)')
  })

  it('does not touch the row tokens the primitives read, so the revealed header keeps its height', () => {
    expect(css).not.toMatch(/--editor-tabs-h\s*:/)
  })
})

describe('Hidden overlay', () => {
  it('the unrevealed tab row is visibility:hidden (no click, no focus) and a revealed one shows without moving layout', () => {
    const row = block(css, '.app-shell--header-hidden > .app-tabs')
    expect(row).toContain('visibility: hidden')
    expect(row).toContain('position: absolute')
    expect(block(css, ".app-shell--header-hidden > [data-revealed='true']")).toContain('visibility: visible')
  })

  it('has no element that can take a click: the edge hairline is pointer-events:none and nothing is position:fixed', () => {
    expect(block(css, '.app-shell--header-hidden::before')).toContain('pointer-events: none')
    expect(css).not.toContain('position: fixed')
    // the only generated box along the edge is that one hairline
    const generated = css.split('\n').filter((l) => /::(?:before|after)/.test(l)).map((l) => l.replace(/\s*[{,].*$/, ''))
    expect(generated).toEqual(['.app-shell--header-hidden::before', 'body.clean-view .app-shell--header-hidden::before'])
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
    for (const f of ['headerMode.store.ts', 'headerMode.commands.ts', 'headerMode.notice.ts', 'headerMode.css', 'useHeaderReveal.ts', 'AppMenuButton.tsx', 'SettingsHeaderMode.tsx', 'WorkspaceBar.tsx', 'WorkspaceBar.tabs.tsx']) {
      expect(src(f), f).not.toMatch(/electrobun|isNative|nativeApp|-webkit-app-region/i)
    }
  })

  it('the reveal hook creates no DOM element', () => {
    const hook = src('useHeaderReveal.ts')
    expect(hook).not.toMatch(/createElement|appendChild|insertAdjacent|createPortal/)
  })
})
