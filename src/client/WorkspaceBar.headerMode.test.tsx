/** @vitest-environment jsdom */
// WorkspaceBar in the three header modes. The inventory below is the header slice of the table in
// docs/decisions/header-rail-layout.md: every header control must stay reachable in Full, Compact and
// Hidden, and the compact menu must open the SAME menu model as the Full menu bar. Workspace tabs and
// `+` are strip controls in Full only; in Compact/Hidden they are rail tiles (WorkspaceRail.inventory.test.tsx
// proves the tiles and `+` are there, so no control is lost).
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

/** Header slice of the inventory: where each control is drawn BY THE HEADER per mode (the rail's half, and the
 *  combined "once per mode" contract, is `headerRail.inventory.test.tsx`). */
const HEADER_CONTROLS: ReadonlyArray<readonly [name: string, drawn: Record<HeaderMode, boolean>]> = [
  ['Search', { full: true, compact: true, hidden: true }], // the command pill
  ['Toggle tab layout', { full: true, compact: true, hidden: false }], // Hidden: rail bottom group
  ['Account', { full: true, compact: false, hidden: false }], // Compact/Hidden: rail bottom group
  ['Toggle Secondary Side Bar', { full: true, compact: true, hidden: true }],
]
/** Strip-only controls: Full draws them in the tab row, Compact/Hidden move them to the rail. */
const STRIP_CONTROLS: ReadonlyArray<readonly [role: string, name: string]> = [['button', 'New workspace'], ['tab', 'Proj']]
/** Menu rows by top-level menu (rows 3-14): the Full menu bar's model, which the rail's menu button reuses. */
const MENU_ROWS: Readonly<Record<string, readonly string[]>> = {
  File: ['New Workspace', 'Clone Repository…', 'New Project…', 'New Files Node', 'Rename Workspace…', 'Delete Workspace', 'Settings…', 'Account…', 'Sign out'],
  View: ['Toggle Tab Layout', 'Header', 'Show Rail Labels', 'Output', 'Clear Output'],
  Help: ['Keyboard Shortcuts Reference', 'Set up webterm…'],
}

describe.each(MODES)('header mode %s', (mode) => {
  it.each(HEADER_CONTROLS)('draws "%s" in the header only where the inventory says', (name, drawn) => {
    mount(mode)
    expect(screen.queryAllByRole('button', { name }).length > 0).toBe(drawn[mode])
  })

  it.each(STRIP_CONTROLS)('%s "%s" is a strip control only in Full', (role, name) => {
    mount(mode)
    expect(Boolean(screen.queryByRole(role, { name: name === 'Proj' ? /Proj/ : name }))).toBe(mode === 'full')
  })

  it('draws a menu bar only in Full (Compact/Hidden: the rail menu button)', () => {
    mount(mode)
    expect(screen.queryAllByRole('menubar')).toHaveLength(mode === 'full' ? 1 : 0)
  })
})

describe('Full menu bar', () => {
  it.each(Object.entries(MENU_ROWS))('opens %s with every row of the model', (top, rows) => {
    mount('full')
    fireEvent.click(screen.getByRole('menuitem', { name: top }))
    const names = [...document.querySelectorAll('[role^="menuitem"]')].map((el) => el.textContent ?? '')
    for (const row of rows) expect(names.some((n) => n.startsWith(row)), `${top} > ${row}`).toBe(true)
  })
})

describe('Compact', () => {
  it('draws no title bar, no brand, no menu and no account (nothing twice: they are rail controls)', () => {
    const { container } = mount('compact')
    expect(container.querySelector('.app-titlebar')).toBeNull()
    expect(container.querySelector('.brand')).toBeNull()
    expect(container.querySelector('.app-menu-button, [role="menubar"]')).toBeNull()
    expect(screen.queryAllByRole('button', { name: 'Account' })).toHaveLength(0)
  })

  it('is one row: the command pill, then the layout switch and the side bar toggle at the end; no workspace tabs', () => {
    const { container } = mount('compact')
    const row = container.querySelector('.app-tabs') as HTMLElement
    expect(row.firstElementChild?.classList.contains('app-titlebar__center')).toBe(true)
    expect(row.querySelector('.app-titlebar__center button[aria-label="Search"]')).toBeTruthy()
    expect(row.querySelector('[role="tablist"], [role="tab"]')).toBeNull()
    expect([...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Search', 'Toggle tab layout', 'Toggle Secondary Side Bar'])
    expect(container.querySelectorAll('button[aria-label="Search"]')).toHaveLength(1)
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
  it('the revealed bar carries the pill and the side bar toggle only (menu, account and layout switch are in the rail)', () => {
    const { container } = mount('hidden', { revealed: true })
    const bar = container.querySelector('.app-titlebar') as HTMLElement
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Search', 'Toggle Secondary Side Bar'])
    expect(bar.querySelector('.brand, [role="menubar"]')).toBeNull()
  })

  it('renders only the title bar as an overlay (no tab row: workspaces are rail tiles): not revealed by default, revealed on demand', () => {
    const { container, rerender } = mount('hidden')
    const rows = [...container.querySelectorAll('[data-header-region]')]
    expect(rows).toHaveLength(1)
    expect(container.querySelector('.app-tabs')).toBeNull()
    expect(rows.map((r) => r.getAttribute('data-revealed'))).toEqual(['false'])
    rerender(
      <WorkspaceBar workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode="hidden" revealed
        onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} />,
    )
    expect([...container.querySelectorAll('[data-header-region]')].map((r) => r.getAttribute('data-revealed'))).toEqual(['true'])
  })
})

describe('View > Header', () => {
  it.each(MODES)('is a radio group that shows the stored mode (%s) and sets the mode', (stored) => {
    setHeaderMode(stored)
    mount('full')
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Header' }))
    for (const m of MODES) {
      const row = screen.getByRole('menuitemcheckbox', { name: new RegExp(m, 'i') })
      expect(row.getAttribute('aria-checked')).toBe(String(m === stored))
    }
    const target = MODES.find((m) => m !== stored) as HeaderMode
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: new RegExp(target, 'i') }))
    expect(getHeaderMode()).toBe(target)
  })
})
