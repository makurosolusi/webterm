// Source scan of the rail (node env, no DOM). No layout engine here, so the guarantee against overlapping items is
// structural: items are in-flow flex children with ONE height token and ONE gap token, nothing in the rail is
// absolutely positioned, the middle group never shrinks under its own content, and the rail scrolls instead of
// overflowing. Also: no hex, no hover-peek, no native branch, no workspace tile left, and file health.
// Registered in scripts/test.policy.manifest.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (f: string): string => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')
const RAIL_FILES = [
  'workspaceOrder.list.ts', 'workspaceTabs.drag.ts', 'workspaceTabs.reorder.ts', 'WorkspaceBar.all.tsx', 'workspaceNav.commands.ts', 'railLabels.store.ts',
  'workspaceTabUi.store.ts', 'dock.rail.css', 'dock.css', 'RailChrome.tsx', 'AppMenuButton.tsx', 'Dock.modes.tsx', 'useWorkspaceMenus.ts', 'App.menu.ts', 'workspaceOrder.save.ts',
]
const rail = src('dock.rail.css')
const dock = src('dock.css')
const MAX_FILE_LINES = 300

/** [selector, body] of every rule in a stylesheet (comments dropped; no nesting in these sheets). */
const rules = (css: string): Array<[string, string]> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]])
const body = (css: string, selector: string): string => rules(css).find(([s]) => s === selector)?.[1] ?? ''

describe('rhythm: one item height, one gap', () => {
  it('declares the tokens once: item 48px, gap 0px, pinned width 220px', () => {
    expect(rail).toMatch(/--rail-item-h:\s*48px/)
    expect(rail).toMatch(/--rail-gap:\s*0px/)
    expect(rail).toMatch(/--rail-w-pinned:\s*220px/)
    expect(rail.match(/--rail-item-h:/g)).toHaveLength(1)
  })

  it('every rail item has the token height (no other height in the sheet) and the groups use the gap token', () => {
    expect(body(rail, '.dock .vscode-activity-bar__item, .dock .dock-btn')).toContain('height: var(--rail-item-h)')
    const heights = rules(rail).flatMap(([, b]) => [...b.matchAll(/(?:^|[;\s])(?:min-|max-)?height:\s*([^;]+)/g)].map((m) => m[1].trim()))
    expect(heights.every((h) => h === 'var(--rail-item-h)'), heights.join(', ')).toBe(true)
    expect(body(rail, '.dock__top, .dock__modes, .dock .vscode-activity-bar__group')).toContain('gap: var(--rail-gap)')
  })

  it('pinning moves the one width token; there is no hover-peek', () => {
    expect(rail).toContain(":root[data-rail-labels='on'] { --activity-bar-w: var(--rail-w-pinned); }")
    expect(rail + dock).not.toMatch(/\.dock:hover|\.vscode-activity-bar:hover/)
  })
})

describe('no absolutely positioned item can float over another', () => {
  it('nothing in the rail sheets is position:absolute or fixed; the bottom group is the one sticky element', () => {
    const offenders = [...rules(rail), ...rules(dock).filter(([s]) => /(^|[\s,])\.dock(__|\b)|\.vscode-activity-bar/.test(s))].filter(([, b]) => /position:\s*(absolute|fixed)/.test(b))
    expect(offenders.map(([s]) => s)).toEqual([])
    const sticky = rules(dock).filter(([, b]) => /position:\s*sticky/.test(b)).map(([s]) => s)
    expect(sticky).toEqual(['.dock__modes'])
  })

  it('the rail is a flex column that scrolls instead of letting items overflow; the tools group never shrinks below its content', () => {
    const dockRule = body(dock, '.dock')
    expect(dockRule).toContain('display: flex')
    expect(dockRule).toContain('flex-direction: column')
    expect(dockRule).toMatch(/overflow-y:\s*auto/)
    const tools = body(dock, '.dock > .vscode-activity-bar')
    expect(tools).toMatch(/flex:\s*1 0 auto/) // no shrink: the old `1 1 auto` + `height: 100%` is what overlapped the icons
    expect(tools).toContain('height: auto')
    expect(body(dock, '.dock__top')).toMatch(/flex:\s*none/)
    expect(body(dock, '.dock__modes')).toMatch(/flex:\s*none/)
  })

  it('the bottom group stays in view with an opaque rail background', () => {
    const modes = body(dock, '.dock__modes')
    expect(modes).toMatch(/bottom:\s*0/)
    expect(modes).toContain('background: var(--vscode-activityBar-background)')
  })
})

describe('tokens, one source for web and native, file health', () => {
  it('uses theme tokens only (no hex)', () => {
    expect(rail).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('no workspace tile or rail workspace group is left anywhere in the client source', () => {
    for (const f of ['App.tsx', 'App.chrome.tsx', 'Dock.tsx', 'Dock.types.ts', 'dock.rail.css', 'dock.css', 'styles.css']) {
      expect(src(f), f).not.toMatch(/WorkspaceRail|workspaceRail|workspaceGroup|ws-tile|ws-rail/)
    }
  })

  it('no rail file branches on native', () => {
    for (const f of RAIL_FILES) expect(src(f), f).not.toMatch(/electrobun|isNative|nativeApp|-webkit-app-region/i)
  })

  it('no rail file passes the size limit', () => {
    for (const f of RAIL_FILES) expect(src(f).split('\n').length, f).toBeLessThanOrEqual(MAX_FILE_LINES)
  })
})
