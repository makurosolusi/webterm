/** @vitest-environment jsdom */
// Inventory (docs/decisions/header-rail-layout.md, table "Inventory: every header control"): the header and the
// rail mounted TOGETHER, in Full, Compact and Hidden. Every control must have exactly one home per mode and no
// control may disappear. The table below is the contract; the tests are driven by it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import AppDock from './App.chrome'
import WorkspaceBar from './WorkspaceBar'
import { chromeMenuProps } from './App.menu'
import { reloadHeaderModeFromStorage, type HeaderMode } from './headerMode.store'
import { RAIL_LABELS_ATTR, getRailLabels, reloadRailLabelsFromStorage } from './railLabels.store'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

const noop = () => {}
const ws: Workspace = { id: 'w1', name: 'Proj', cwd: '/proj', viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0, position: 0 } as Workspace // test-only
const MODES: readonly HeaderMode[] = ['full', 'compact', 'hidden']
type Home = 'header' | 'rail'

/** control (role + accessible name) -> every place it is drawn per mode, from the inventory table. */
const CONTROLS: ReadonlyArray<{ role: string; name: string; home: Record<HeaderMode, Home[]> }> = [
  // row 15: the command pill is the Search button in the header; Hidden adds a rail Search (the header only shows on reveal)
  { role: 'button', name: 'Search', home: { full: ['header'], compact: ['header'], hidden: ['header', 'rail'] } },
  { role: 'button', name: 'Toggle tab layout', home: { full: ['header'], compact: ['header'], hidden: ['rail'] } }, // row 22
  { role: 'button', name: 'Account', home: { full: ['header'], compact: ['rail'], hidden: ['rail'] } }, // row 18
  { role: 'button', name: 'Toggle Secondary Side Bar', home: { full: ['header'], compact: ['header'], hidden: ['header'] } }, // row 17
  { role: 'button', name: 'Settings', home: { full: ['rail'], compact: ['rail'], hidden: ['rail'] } }, // row 9 twin
  { role: 'button', name: 'Clean view', home: { full: ['rail'], compact: ['rail'], hidden: ['rail'] } },
  { role: 'menuitem', name: 'Menu', home: { full: [], compact: ['rail'], hidden: ['rail'] } }, // row 2: the compact menu button
  { role: 'menuitem', name: 'File', home: { full: ['header'], compact: [], hidden: [] } }, // Full: the bar's own labels
]
/** Menu rows by top-level menu (rows 3-14 + the rail labels row): the same in every mode. */
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
      workspaces: [ws], activeId: 'w1', liveNodes: [], statuses: {}, onNewProject: vi.fn(), onDeleteWorkspace: vi.fn(async () => undefined),
      onAddFiles: vi.fn(), setShowSettings: vi.fn(), setShowHelp: vi.fn(), openAccount: vi.fn(), onLogout: vi.fn(), signedIn: true,
    }),
    ...over,
  }
  const rail = mode === 'full' ? {} : {
    workspaceRail: { workspaces: [ws], activeId: 'w1', liveActiveNodes: [], statuses: {}, onSelect: vi.fn(), onRenameWorkspace: vi.fn(async () => undefined) },
    railChrome: { ...menu, layoutInRail: mode === 'hidden' },
  }
  return render(
    <MemoryRouter>
      <WorkspaceBar {...menu} workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode={mode} revealed
        onSelect={vi.fn()} onRenameWorkspace={vi.fn()} onOpenPalette={vi.fn()} layoutMode="canvas"
        titleActions={<button type="button" aria-label="Toggle Secondary Side Bar" />} />
      <AppDock
        vp={{ zoom: 1, syncViewport: noop, onMoveEnd: noop, onFit: noop, onZoomIn: noop, onZoomOut: noop, onZoomTo: noop, onPanBy: noop, onBack: noop, onForward: noop, canBack: false, canForward: false, resetViewport: noop }}
        settings={DEFAULT_SETTINGS} activeWs={ws} board={false} setBoard={noop} sideBar={{ open: false, view: 'layers', select: noop }} sessionsAttention={0}
        locked={false} setLocked={noop} cleanView={false} toggleCleanView={noop} setPicker={noop} setShowSettings={noop}
        onAddTerminal={noop} onAddAgent={noop} onCreateWorkspace={noop} onUndo={noop} onRedo={noop} canUndo={false} canRedo={false}
        onOpenPalette={mode === 'hidden' ? noop : undefined}
        {...rail}
      />
    </MemoryRouter>,
  )
}

const inRail = (el: Element): boolean => el.closest('.dock') !== null
const found = (role: string, name: string): Element[] => screen.queryAllByRole(role, { name })

describe.each(MODES)('header mode %s: every control has its home, once', (mode) => {
  it.each(CONTROLS)('$role "$name"', ({ role, name, home }) => {
    mount(mode)
    const places = found(role, name).map((el): Home => (inRail(el) ? 'rail' : 'header'))
    expect(places.sort(), `${name} in ${mode}`).toEqual([...home[mode]].sort())
  })

  it.each(Object.entries(MENU_ROWS))('menu %s lists every row of the one model', (top, rows) => {
    mount(mode)
    if (mode === 'full') {
      fireEvent.click(screen.getByRole('menuitem', { name: top }))
    } else {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' }))
      fireEvent.click(screen.getByRole('menuitem', { name: top }))
    }
    const names = [...document.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? '')
    for (const row of rows) expect(names.some((n) => n.startsWith(row)), `${top} > ${row}`).toBe(true)
  })

  it('the menu button is a rail control in Compact/Hidden and the menu bar a header control in Full (never both)', () => {
    const { container } = mount(mode)
    expect(container.querySelectorAll('[role="menubar"]')).toHaveLength(1)
    const bar = container.querySelector('[role="menubar"]') as HTMLElement
    expect(inRail(bar)).toBe(mode !== 'full')
    expect(bar.closest('.app-titlebar, .app-tabs') !== null).toBe(mode === 'full')
  })

  it('has no brand, menu bar or account button left in the header outside Full', () => {
    const { container } = mount(mode)
    const stray = container.querySelectorAll('.app-titlebar .brand, .app-titlebar [role="menubar"], .app-titlebar button[aria-label="Account"], .app-tabs button[aria-label="Account"]')
    expect(stray.length).toBe(mode === 'full' ? 3 : 0)
  })
})

describe('menu model equality (one model, two doors)', () => {
  it.each(Object.keys(MENU_ROWS))('%s opens exactly the rows in Full, Compact and Hidden', (top) => {
    const rowsIn = (mode: HeaderMode): string[] => {
      const view = mount(mode)
      if (mode !== 'full') fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' }))
      fireEvent.click(screen.getByRole('menuitem', { name: top }))
      const rows = [...document.querySelectorAll(mode === 'full' ? '.vscode-menu__item' : '.vscode-menu__submenu .vscode-menu__item')].map((el) => el.textContent ?? '')
      view.unmount()
      return rows
    }
    const full = rowsIn('full')
    expect(full.length).toBeGreaterThan(1)
    expect(rowsIn('compact')).toEqual(full)
    expect(rowsIn('hidden')).toEqual(full)
  })

  it('the same handlers run: File > Settings… from the rail menu calls onOpenSettings', () => {
    // chromeMenuProps wires onOpenSettings to setShowSettings(true); replaced here to observe it.
    const onOpenSettings = vi.fn()
    mount('compact', { onOpenSettings })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})

describe('lone Alt focuses the menu in every mode (Hidden included: the rail button is always visible)', () => {
  it.each(MODES)('%s', (mode) => {
    mount(mode)
    fireEvent.keyDown(document, { key: 'Alt' })
    fireEvent.keyUp(document, { key: 'Alt' })
    const target = screen.getByRole('menuitem', { name: mode === 'full' ? 'File' : 'Menu' })
    expect(document.activeElement).toBe(target)
  })
})

describe('rail order (docs: menu on top, Account before Settings in the bottom group)', () => {
  it.each(['compact', 'hidden'] as const)('%s: menu first; Account, then Settings, then the Hidden-only layout switch', (mode) => {
    const { container } = mount(mode)
    const dock = container.querySelector('.dock') as HTMLElement
    expect(dock.firstElementChild?.classList.contains('app-menu-button')).toBe(true)
    const bottom = [...(dock.querySelector('.dock__modes') as HTMLElement).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(bottom.slice(0, mode === 'hidden' ? 3 : 2)).toEqual(mode === 'hidden' ? ['Account', 'Settings', 'Toggle tab layout'] : ['Account', 'Settings'])
  })

  it('the layout switch in the rail runs the same toggle and mirrors aria-pressed', () => {
    const onToggleLayout = vi.fn()
    mount('hidden', { onToggleLayout })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle tab layout' }))
    expect(onToggleLayout).toHaveBeenCalledTimes(1)
  })
})

describe('pinned rail (Show labels): every rail control is named and styled to show its name', () => {
  const LABELLED = ['.vscode-activity-bar__item', '.dock-btn', '.ws-rail__btn', '.ws-tile', '.app-menu-button .vscode-menu-bar__item']
  const css = readFileSync('src/client/workspaceRail.css', 'utf8')

  it.each(MODES)('%s: each button in the rail has an accessible name and one of the pinned-label classes', (mode) => {
    const { container } = mount(mode)
    const controls = [...(container.querySelector('.dock') as HTMLElement).querySelectorAll('button, [role="menuitem"], [role="tab"]')]
    expect(controls.length).toBeGreaterThan(5)
    for (const el of controls) {
      const name = el.getAttribute('data-label') ?? el.getAttribute('aria-label') ?? el.textContent
      expect(name?.trim(), el.outerHTML.slice(0, 80)).toBeTruthy()
      expect(LABELLED.some((sel) => el.matches(sel)), `${name} has no pinned-label class`).toBe(true)
    }
  })

  it('the stylesheet gives each of those classes a pinned-rail rule', () => {
    expect(css).toMatch(/\[data-rail-labels='on'\] \.vscode-activity-bar__item::after \{ content: attr\(data-label\)/)
    expect(css).toMatch(/\[data-rail-labels='on'\] \.dock-btn::after \{ content: attr\(aria-label\)/)
    expect(css).toMatch(/\[data-rail-labels='on'\] \.ws-rail__btn::after/)
    expect(css).toMatch(/\[data-rail-labels='on'\] \.ws-tile__name \{ display: block/)
    expect(css).toMatch(/\[data-rail-labels='on'\] \.app-menu-button \.vscode-menu-bar__item \{[^}]*font-size: 13px/)
  })

  it('View > Show Rail Labels is a checkbox row in the rail menu and flips the stored preference', () => {
    mount('compact')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    const row = screen.getByRole('menuitemcheckbox', { name: /Show Rail Labels/ })
    expect(row.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(row)
    expect(getRailLabels()).toBe(true)
    expect(document.documentElement.getAttribute(RAIL_LABELS_ATTR)).toBe('on')
  })
})
