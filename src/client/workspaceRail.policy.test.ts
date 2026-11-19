// Source scan of the workspace rail (node env, no DOM): sizes and tokens, the vertical tablist contract,
// one source for names/tooltips/status with the header tab, no hex, no hover-peek, no native branch,
// and file health. Registered in scripts/test.policy.manifest.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (f: string): string => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')
const RAIL_FILES = [
  'WorkspaceRail.tsx', 'WorkspaceRail.tile.tsx', 'WorkspaceRail.all.tsx', 'WorkspaceRail.rename.tsx',
  'workspaceRail.order.ts', 'workspaceRail.keys.ts', 'workspaceRail.drag.ts', 'workspaceRail.reorder.ts', 'workspaceRail.overflow.ts',
  'workspaceTiles.ts', 'workspaceNav.commands.ts', 'railLabels.store.ts', 'workspaceTabUi.store.ts', 'workspaceRail.css',
  'RailChrome.tsx', 'Dock.modes.tsx', 'useWorkspaceMenus.ts', 'App.menu.ts', 'workspaceOrder.save.ts',
]
const css = src('workspaceRail.css')
const MAX_FILE_LINES = 300

describe('rail tokens and sizes', () => {
  it('tile 32px, pitch 36px, pinned rail 220px, all as tokens', () => {
    expect(css).toMatch(/--rail-ws-tile:\s*32px/)
    expect(css).toMatch(/--rail-ws-pitch:\s*36px/)
    expect(css).toMatch(/--rail-w-pinned:\s*220px/)
    expect(css).toMatch(/\.ws-tile__mono\s*\{[^}]*font-size:\s*14px;\s*font-weight:\s*700/)
  })

  it('the workspace group is the flexible region: shrinks first, scrolls, active cell sticky', () => {
    expect(css).toMatch(/\.ws-rail\s*\{[^}]*flex:\s*0 1000 auto/)
    expect(css).toMatch(/\.ws-rail__tabs\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/)
    expect(css).toMatch(/\.ws-rail__cell\[data-active='true'\]\s*\{[^}]*position:\s*sticky/)
  })

  it('pinning moves the one width token; there is no hover-peek', () => {
    expect(css).toContain(":root[data-rail-labels='on'] { --activity-bar-w: var(--rail-w-pinned); }")
    expect(css).not.toMatch(/\.dock:hover|\.ws-rail:hover|\.vscode-activity-bar:hover/)
  })

  it('uses theme tokens only (no hex) and respects reduced motion', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).toContain('prefers-reduced-motion: reduce')
  })
})

describe('tile contract', () => {
  const group = src('WorkspaceRail.tsx')
  const tile = src('WorkspaceRail.tile.tsx')

  it('is a vertical tablist of tabs with selection and a canvas control', () => {
    expect(group).toContain('role="tablist"')
    expect(group).toContain('aria-orientation="vertical"')
    expect(group).toContain('aria-label="Workspaces"')
    expect(tile).toContain('role="tab"')
    expect(tile).toContain('aria-selected')
    expect(tile).toContain('aria-controls')
  })

  it('reads name, tooltip and status from the same functions as the header tab (one source)', () => {
    expect(tile).toContain('workspaceTabFields(')
    expect(tile).toContain('workspaceTabDot(')
    expect(src('WorkspaceBar.tabs.tsx')).toContain('workspaceTabFields(')
  })

  it('reuses the header menu and rename instead of forking them', () => {
    expect(group.replace(/\/\/.*$/gm, '')).not.toMatch(/NodeContextMenu|WorkspaceTabMenu/)
    expect(src('WorkspaceBar.hosts.tsx')).toContain('WorkspaceTabMenu')
    expect(src('WorkspaceRail.rename.tsx')).toContain('WorkspaceTabRename')
  })

  it('Full never shows tiles: App passes the rail props only outside Full', () => {
    expect(src('App.tsx')).toMatch(/workspaceRail:\s*headerMode === 'full' \? undefined/)
  })
})

describe('one source for web and native, file health', () => {
  it('no rail file branches on native', () => {
    for (const f of RAIL_FILES) expect(src(f), f).not.toMatch(/electrobun|isNative|nativeApp|-webkit-app-region/i)
  })

  it('no rail file passes the size limit, and none is named after the T2b client module', () => {
    for (const f of RAIL_FILES) expect(src(f).split('\n').length, f).toBeLessThanOrEqual(MAX_FILE_LINES)
    expect(RAIL_FILES.some((f) => f.startsWith('workspaceOrder.api'))).toBe(false)
  })
})
