/** @vitest-environment jsdom */
// WorkspaceBar in the three header modes. The inventory below is the T1 slice of the table in
// docs/decisions/header-rail-layout.md: every header control must stay reachable in Full, Compact and
// Hidden, and the compact menu must open the SAME menu model as the Full menu bar.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar, { type WorkspaceBarProps } from './WorkspaceBar'
import { getHeaderMode, reloadHeaderModeFromStorage, setHeaderMode, type HeaderMode } from './headerMode.store'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

const ws: Workspace = { id: 'w1', name: 'Proj', cwd: '/proj', viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 } // test-only
const MODES: readonly HeaderMode[] = ['full', 'compact', 'hidden']

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
  localStorage.clear()
  reloadHeaderModeFromStorage()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(headerMode: HeaderMode, over: Partial<WorkspaceBarProps> = {}) {
  return render(
    <WorkspaceBar
      workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode={headerMode}
      onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()}
      onOpenSettings={vi.fn()} onOpenHelp={vi.fn()} onOpenPalette={vi.fn()} onToggleLayout={vi.fn()} onNewFiles={vi.fn()}
      showLogout onOpenAccount={vi.fn()} onLogout={vi.fn()}
      titleActions={<button type="button" aria-label="Toggle Secondary Side Bar" />}
      {...over}
    />,
  )
}

/** Inventory slice: control -> accessible role + name, present in every mode (Hidden: in the reveal overlay). */
const DIRECT_CONTROLS: ReadonlyArray<readonly [role: string, name: string]> = [
  ['button', 'Search'], ['button', 'New workspace'], ['button', 'Toggle tab layout'], ['button', 'Account'],
  ['button', 'Toggle Secondary Side Bar'], ['tab', 'Proj'],
]
/** Inventory slice: menu rows by their top-level menu. Header is the new View > Header row. */
const MENU_ROWS: Readonly<Record<string, readonly string[]>> = {
  File: ['New Workspace', 'Clone Repository…', 'New Project…', 'New Files Node', 'Rename Workspace…', 'Delete Workspace', 'Settings…', 'Account…', 'Sign out'],
  View: ['Toggle Tab Layout', 'Header', 'Output', 'Clear Output'],
  Help: ['Keyboard Shortcuts Reference', 'Set up webterm…'],
}

/** Opens a top-level menu the way the mode draws it: the bar's own label, or Menu > submenu in Compact. */
function openTop(mode: HeaderMode, top: string): void {
  if (mode === 'compact') {
    if (!screen.queryByRole('menuitem', { name: 'File', hidden: false })) fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: top }))
  } else {
    fireEvent.click(screen.getByRole('menuitem', { name: top }))
  }
}
const rowsOf = (): string[] => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')

describe.each(MODES)('header mode %s', (mode) => {
  it.each(DIRECT_CONTROLS)('keeps %s "%s" reachable', (role, name) => {
    mount(mode)
    expect(screen.getByRole(role, { name: name === 'Proj' ? /Proj/ : name })).toBeTruthy()
  })

  it.each(Object.entries(MENU_ROWS))('opens %s with every row of the one menu model', (top, rows) => {
    mount(mode)
    openTop(mode, top)
    const names = [...document.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? '')
    for (const row of rows) expect(names.some((n) => n.startsWith(row)), `${top} > ${row}`).toBe(true)
  })
})

describe('Compact', () => {
  it('draws no title bar (nothing twice) and one menu button with the same File / View / Help model', () => {
    const { container } = mount('compact')
    expect(container.querySelector('.app-titlebar')).toBeNull()
    expect(container.querySelector('.brand')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Account' })).toHaveLength(1)
    expect(screen.getAllByRole('menubar')).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' }))
    expect(rowsOf()).toEqual(['Menu', 'File', 'View', 'Help'])
  })

  it.each(Object.keys(MENU_ROWS))('%s opens exactly the rows the Full menu bar opens (one model, two doors)', (top) => {
    const rowsIn = (mode: HeaderMode): string[] => {
      const view = mount(mode)
      openTop(mode, top)
      const rows = [...document.querySelectorAll(mode === 'compact' ? '.vscode-menu__submenu .vscode-menu__item' : '.vscode-menu__item')].map((el) => el.textContent ?? '')
      view.unmount()
      return rows
    }
    const full = rowsIn('full')
    expect(full.length).toBeGreaterThan(1)
    expect(rowsIn('compact')).toEqual(full)
  })

  it('the menu button sits first in the tab row and search, side bar toggle and account sit at its end', () => {
    const { container } = mount('compact')
    const row = container.querySelector('.app-tabs') as HTMLElement
    expect(row.firstElementChild?.classList.contains('app-menu-button')).toBe(true)
    const tail = row.lastElementChild as HTMLElement
    expect([...tail.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Search', 'Toggle Secondary Side Bar', 'Account'])
  })

  it('the same handlers run: File > Settings… from the compact menu calls onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    mount('compact', { onOpenSettings })
    openTop('compact', 'File')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('lone Alt focuses the menu button (same primitive as the menu bar)', () => {
    mount('compact')
    fireEvent.keyDown(document, { key: 'Alt' })
    fireEvent.keyUp(document, { key: 'Alt' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Menu' }))
  })
})

describe('Full', () => {
  it('keeps both rows, the brand and the menu bar', () => {
    const { container } = mount('full')
    expect(container.querySelector('.app-titlebar .brand')).toBeTruthy()
    expect(container.querySelector('.app-tabs')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['File', 'View', 'Help'])
    expect(container.querySelector('[data-revealed]')).toBeNull()
  })
})

describe('Hidden', () => {
  it('renders both rows as an overlay: not revealed by default, revealed on demand, no extra element', () => {
    const { container, rerender } = mount('hidden')
    const rows = [...container.querySelectorAll('[data-header-region]')]
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.getAttribute('data-revealed'))).toEqual(['false', 'false'])
    rerender(
      <WorkspaceBar workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode="hidden" revealed
        onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} />,
    )
    expect([...container.querySelectorAll('[data-header-region]')].map((r) => r.getAttribute('data-revealed'))).toEqual(['true', 'true'])
  })
})

describe('View > Header', () => {
  it.each(MODES)('is a radio group that shows the stored mode (%s) and sets the mode', (stored) => {
    setHeaderMode(stored)
    mount('full')
    openTop('full', 'View')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Header' }))
    for (const m of MODES) {
      const row = screen.getByRole('menuitemcheckbox', { name: new RegExp(m, 'i') })
      expect(row.getAttribute('aria-checked')).toBe(String(m === stored))
    }
    const target = MODES.find((m) => m !== stored) as HeaderMode
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: new RegExp(target, 'i') }))
    expect(getHeaderMode()).toBe(target)
  })

  it('works from the compact menu too (View > Header > Hidden)', () => {
    setHeaderMode('compact')
    mount('compact')
    openTop('compact', 'View')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Header' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Hidden/ }))
    expect(getHeaderMode()).toBe('hidden')
  })
})
