/** @vitest-environment jsdom */
// Inventory (docs/decisions/header-rail-layout.md, "Rework 2026-11-19"): the header (tab row) and the rail mounted
// TOGETHER, in Tabs and Hidden. Every control has exactly one home per mode and none may disappear. The table
// below is the contract; the tests are driven by it. Also: the rail's DOM order, no workspace tile anywhere, and the
// pinned-rail naming.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import AppDock from './App.chrome'
import WorkspaceBar from './WorkspaceBar'
import { chromeMenuProps } from './App.menu'
import { HEADER_MODES, reloadHeaderModeFromStorage, type HeaderMode } from './headerMode.store'
import { RAIL_LABELS_ATTR, getRailLabels, reloadRailLabelsFromStorage } from './railLabels.store'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

const noop = () => {}
const mk = (id: string, name: string, position: number): Workspace => ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0, position }) as Workspace // test-only
const WS = [mk('w1', 'Proj', 0), mk('w2', 'Other', 1)]
type Home = 'header' | 'rail'

/** control (role + accessible name) -> every place it is drawn per mode. */
const CONTROLS: ReadonlyArray<{ role: string; name: string; home: Record<HeaderMode, Home[]> }> = [
  { role: 'button', name: 'Menu', home: { tabs: ['rail'], hidden: ['rail'] } }, // the one hamburger (File / View / Help)
  { role: 'button', name: 'Search', home: { tabs: ['rail'], hidden: ['rail'] } }, // no pill in the header any more
  { role: 'button', name: 'Account', home: { tabs: ['rail'], hidden: ['rail'] } },
  { role: 'button', name: 'Settings', home: { tabs: ['rail'], hidden: ['rail'] } },
  { role: 'button', name: 'Clean view', home: { tabs: ['rail'], hidden: ['rail'] } },
  { role: 'button', name: 'Lock view', home: { tabs: ['rail'], hidden: ['rail'] } },
  { role: 'button', name: 'Toggle tab layout', home: { tabs: ['header'], hidden: ['rail'] } },
  { role: 'button', name: 'Toggle Secondary Side Bar', home: { tabs: ['header'], hidden: ['header'] } },
  { role: 'button', name: 'New workspace', home: { tabs: ['header'], hidden: ['header'] } },
  { role: 'button', name: 'All workspaces', home: { tabs: ['header'], hidden: ['header'] } },
  { role: 'tab', name: 'Workspace Proj', home: { tabs: ['header'], hidden: ['header'] } },
  { role: 'tab', name: 'Workspace Other', home: { tabs: ['header'], hidden: ['header'] } },
]
/** Menu rows by top-level menu: the same in both modes (one model). */
const MENU_ROWS: Readonly<Record<string, readonly string[]>> = {
  File: ['New Workspace', 'Clone Repository…', 'New Project…', 'New Files Node', 'Rename Workspace…', 'Delete Workspace', 'Settings…', 'Account…', 'Sign out'],
  View: ['Toggle Tab Layout', 'Header', 'Show Rail Labels', 'Output', 'Clear Output'],
  Help: ['Keyboard Shortcuts Reference', 'Set up webterm…'],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false, items: [] }))))
  localStorage.clear()
  reloadHeaderModeFromStorage()
  reloadRailLabelsFromStorage()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute(RAIL_LABELS_ATTR) })

function mount(mode: HeaderMode, over: { onOpenSettings?: () => void; onToggleLayout?: () => void } = {}) {
  const menu = {
    ...chromeMenuProps({
      workspaces: WS, activeId: 'w1', liveNodes: [], statuses: {}, onNewProject: vi.fn(), onDeleteWorkspace: vi.fn(async () => undefined),
      onAddFiles: vi.fn(), setShowSettings: vi.fn(), setShowHelp: vi.fn(), openAccount: vi.fn(), onLogout: vi.fn(), signedIn: true,
    }),
    ...over,
  }
  return render(
    <MemoryRouter>
      <WorkspaceBar {...menu} workspaces={WS} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode={mode} revealed railChrome
        onSelect={vi.fn()} onRenameWorkspace={vi.fn()} layoutMode="canvas"
        titleActions={<button type="button" aria-label="Toggle Secondary Side Bar" />} />
      <AppDock
        vp={{ zoom: 1, syncViewport: noop, onMoveEnd: noop, onFit: noop, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop, onPanBy: noop, onBack: noop, onForward: noop, canBack: false, canForward: false, resetViewport: noop }}
        settings={DEFAULT_SETTINGS} activeWs={WS[0]} board={false} setBoard={noop} sideBar={{ open: false, view: 'layers', select: noop }} sessionsAttention={0}
        locked={false} setLocked={noop} cleanView={false} toggleCleanView={noop} setPicker={noop} setShowSettings={noop}
        onAddTerminal={noop} onAddAgent={noop} onCreateWorkspace={noop} onUndo={noop} onRedo={noop} canUndo={false} canRedo={false}
        onOpenPalette={noop}
        railChrome={{ ...menu, layoutInRail: mode === 'hidden' }}
      />
    </MemoryRouter>,
  )
}

const inRail = (el: Element): boolean => el.closest('.dock') !== null
const found = (role: string, name: string | RegExp): Element[] => screen.queryAllByRole(role, { name })

describe.each(HEADER_MODES)('header mode %s: every control has its home, once', (mode) => {
  it.each(CONTROLS)('$role "$name"', ({ role, name, home }) => {
    mount(mode)
    const places = found(role, name.startsWith('Workspace ') ? new RegExp(`^${name}`) : name).map((el): Home => (inRail(el) ? 'rail' : 'header'))
    expect(places.sort(), `${name} in ${mode}`).toEqual([...home[mode]].sort())
  })

  it.each(Object.entries(MENU_ROWS))('menu %s lists every row of the one model', (top, rows) => {
    mount(mode)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: top }))
    const names = [...document.querySelectorAll('[data-level="1"] [role^="menuitem"]')].map((el) => el.textContent ?? '')
    for (const row of rows) expect(names.some((n) => n.startsWith(row)), `${top} > ${row}`).toBe(true)
  })

  it('has no title bar, brand, menu bar or workspace tile anywhere, and exactly one header region', () => {
    const { container } = mount(mode)
    expect(container.querySelectorAll('.app-titlebar, .brand, [role="menubar"], .ws-tile, .ws-rail, [data-slot="workspace-tile"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-header-region]')).toHaveLength(1)
    expect(container.querySelector('.dock [role="tab"], .dock [role="tablist"]')).toBeNull()
  })

  it('lone Alt focuses the menu button (the rail is always visible, Hidden included)', () => {
    mount(mode)
    fireEvent.keyDown(document, { key: 'Alt' })
    fireEvent.keyUp(document, { key: 'Alt' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menu' }))
  })
})

describe('menu model equality (one model, both modes)', () => {
  it.each(Object.keys(MENU_ROWS))('%s opens exactly the same rows in Tabs and Hidden', (top) => {
    const rowsIn = (mode: HeaderMode): string[] => {
      const view = mount(mode)
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
      fireEvent.click(screen.getByRole('menuitem', { name: top }))
      const rows = [...document.querySelectorAll('[data-level="1"] [role^="menuitem"]')].map((el) => el.textContent ?? '')
      view.unmount()
      return rows
    }
    const tabs = rowsIn('tabs')
    expect(tabs.length).toBeGreaterThan(1)
    expect(rowsIn('hidden')).toEqual(tabs)
  })

  it('the same handlers run: File > Settings… from the rail menu calls onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    mount('tabs', { onOpenSettings })
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('opening View then Help leaves only Help\'s rows on screen (the reported overlap)', () => {
    mount('tabs')
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    expect(document.querySelectorAll('[role="menu"][data-level="1"]')).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: /Toggle Tab Layout/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Keyboard Shortcuts Reference/ })).toBeTruthy()
  })
})

describe('rail order: menu, Search, tools, then the bottom group', () => {
  it.each(HEADER_MODES)('%s: DOM order of the rail', (mode) => {
    const { container } = mount(mode)
    const dock = container.querySelector('.dock') as HTMLElement
    const kids = [...dock.children].map((el) => el.className)
    expect(kids.slice(0, 3)).toEqual(['dock__top', 'vscode-activity-bar', 'dock__modes'])
    const top = [...(dock.querySelector('.dock__top') as HTMLElement).children].map((b) => b.getAttribute('aria-label'))
    expect(top).toEqual(['Menu', 'Search'])
    const tools = [...dock.querySelectorAll('.vscode-activity-bar button')].map((b) => b.getAttribute('aria-label'))
    expect(tools).toEqual(['Layers', 'Sessions', 'Agent History', 'Skills', 'Central', 'Board', 'Add node'])
    const bottom = [...(dock.querySelector('.dock__modes') as HTMLElement).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(bottom).toEqual(mode === 'hidden'
      ? ['Account', 'Settings', 'Toggle tab layout', 'Lock view', 'Clean view']
      : ['Account', 'Settings', 'Lock view', 'Clean view'])
  })

  it('the layout switch in the rail (Hidden) runs the same toggle', () => {
    const onToggleLayout = vi.fn()
    mount('hidden', { onToggleLayout })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle tab layout' }))
    expect(onToggleLayout).toHaveBeenCalledTimes(1)
  })
})

describe('pinned rail (Show labels): every rail control is named and styled to show its name', () => {
  const LABELLED = ['.vscode-activity-bar__item', '.dock-btn']
  const css = readFileSync('src/client/dock.rail.css', 'utf8')

  it.each(HEADER_MODES)('%s: each button in the rail has an accessible name and one of the pinned-label classes', (mode) => {
    const { container } = mount(mode)
    const controls = [...(container.querySelector('.dock') as HTMLElement).querySelectorAll('button, [role="menuitem"], [role="tab"]')]
    expect(controls.length).toBeGreaterThan(8)
    for (const el of controls) {
      const name = el.getAttribute('data-label') ?? el.getAttribute('aria-label') ?? el.textContent
      expect(name?.trim(), el.outerHTML.slice(0, 80)).toBeTruthy()
      expect(LABELLED.some((sel) => el.matches(sel)), `${name} has no pinned-label class`).toBe(true)
    }
  })

  it('the stylesheet gives each of those classes a pinned-rail rule', () => {
    expect(css).toMatch(/\[data-rail-labels='on'\] \.vscode-activity-bar__item::after \{ content: attr\(data-label\)/)
    expect(css).toMatch(/\[data-rail-labels='on'\] \.dock-btn::after \{ content: attr\(aria-label\)/)
  })

  it('View > Show Rail Labels is a checkbox row in the rail menu and flips the stored preference', () => {
    mount('tabs')
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    const row = screen.getByRole('menuitemcheckbox', { name: /Show Rail Labels/ })
    expect(row.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(row)
    expect(getRailLabels()).toBe(true)
    expect(document.documentElement.getAttribute(RAIL_LABELS_ATTR)).toBe('on')
  })
})
