/** @vitest-environment jsdom */
// WorkspaceBar in the two header modes. The header is ONE row of workspace tabs: there is no title bar, no brand and no
// menu bar in any mode. The inventory below is the header slice of docs/decisions/header-rail-layout.md; the rail's
// half and the combined "once per mode" contract is `headerRail.inventory.test.tsx`.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar, { type WorkspaceBarProps } from './WorkspaceBar'
import { getHeaderMode, reloadHeaderModeFromStorage, setHeaderMode, HEADER_MODES, type HeaderMode } from './headerMode.store'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

const mk = (id: string, name: string): Workspace => ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 }) // test-only
const ws = mk('w1', 'Proj')

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
      onOpenSettings={vi.fn()} onOpenHelp={vi.fn()} onToggleLayout={vi.fn()} onNewFiles={vi.fn()}
      showLogout onOpenAccount={vi.fn()} onLogout={vi.fn()}
      titleActions={<button type="button" aria-label="Toggle Secondary Side Bar" />}
      {...over}
    />,
  )
}

/** Menu rows by top-level menu: the one model behind the menu button (the rail's door and the row's own). */
const MENU_ROWS: Readonly<Record<string, readonly string[]>> = {
  File: ['New Workspace', 'Clone Repository…', 'New Project…', 'New Files Node', 'Rename Workspace…', 'Delete Workspace', 'Settings…', 'Account…', 'Sign out'],
  View: ['Toggle Tab Layout', 'Header', 'Show Rail Labels', 'Output', 'Clear Output'],
  Help: ['Keyboard Shortcuts Reference', 'Set up webterm…'],
}

describe.each(HEADER_MODES)('header mode %s: no title bar, ever', (mode) => {
  it('draws no title bar, brand, menu bar or command pill', () => {
    const { container } = mount(mode)
    expect(container.querySelector('.app-titlebar, .brand, [role="menubar"], .app-titlebar__name')).toBeNull()
    expect(screen.queryAllByRole('button', { name: 'Search' })).toHaveLength(0) // Search is a rail item
  })

  it('renders exactly one header region: the tab row, with the workspace tabs and the + button', () => {
    const { container } = mount(mode)
    const regions = container.querySelectorAll('[data-header-region]')
    expect(regions).toHaveLength(1)
    expect(regions[0].classList.contains('app-tabs')).toBe(true)
    expect(screen.getByRole('tablist', { name: 'Workspaces' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Proj/ })).toBeTruthy()
    expect(regions[0].querySelector('button[aria-label="New workspace"]')).toBeTruthy()
  })
})

describe('Tabs', () => {
  it('draws the row in the grid (no overlay attribute) with the layout switch and the side bar toggle at its end', () => {
    const { container } = mount('tabs')
    const row = container.querySelector('.app-tabs') as HTMLElement
    expect(row.hasAttribute('data-revealed')).toBe(false)
    const tail = row.querySelector('.app-tabs__tail') as HTMLElement
    expect([...tail.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Toggle tab layout', 'Toggle Secondary Side Bar', 'Account'])
  })

  it('with the rail on screen the row carries neither the menu button nor the account button (nothing twice)', () => {
    const { container } = mount('tabs', { railChrome: true })
    expect(screen.queryAllByRole('button', { name: 'Menu' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Account' })).toHaveLength(0)
    expect(container.querySelector('.app-tabs__lead')).toBeNull()
  })

  it('without a rail (booting, no workspace yet) the row leads with the menu button and ends with Account, so nothing is unreachable', () => {
    const { container } = mount('tabs', { workspaces: [], activeId: null })
    const row = container.querySelector('.app-tabs') as HTMLElement
    expect((row.firstElementChild as HTMLElement).classList.contains('app-tabs__lead')).toBe(true)
    expect(row.querySelector('.app-tabs__lead button')?.getAttribute('aria-label')).toBe('Menu')
    expect(row.querySelector('button[aria-label="Account"]')).toBeTruthy()
    expect(row.querySelector('button[aria-label="New workspace"]')).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: 'Toggle tab layout' })).toHaveLength(0) // nothing to switch
  })

  it.each(Object.entries(MENU_ROWS))('the row\'s own menu button opens %s with every row of the model', (top, rows) => {
    mount('tabs', { railChrome: false })
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: top }))
    const names = [...document.querySelectorAll('[data-level="1"] [role^="menuitem"]')].map((el) => el.textContent ?? '')
    for (const row of rows) expect(names.some((n) => n.startsWith(row)), `${top} > ${row}`).toBe(true)
  })
})

describe('Hidden', () => {
  it('is the same row as an overlay: not revealed by default, revealed on demand', () => {
    const { container, rerender } = mount('hidden')
    const row = container.querySelector('.app-tabs') as HTMLElement
    expect(row.getAttribute('data-revealed')).toBe('false')
    rerender(
      <WorkspaceBar workspaces={[ws]} activeId="w1" liveActiveNodes={[]} statuses={{}} headerMode="hidden" revealed
        onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} />,
    )
    expect((container.querySelector('.app-tabs') as HTMLElement).getAttribute('data-revealed')).toBe('true')
  })

  it('the layout switch is NOT in the row (it is a rail button there), the side bar toggle is', () => {
    mount('hidden', { revealed: true })
    expect(screen.queryAllByRole('button', { name: 'Toggle tab layout' })).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: 'Toggle Secondary Side Bar' })).toHaveLength(1)
  })
})

describe('All workspaces (Chrome\'s "search tabs")', () => {
  it('appears with two or more workspaces, lists every one, filters, and switches to the picked one', async () => {
    const onSelect = vi.fn()
    mount('tabs', { workspaces: [ws, mk('w2', 'Other')], onSelect, railChrome: true })
    fireEvent.click(screen.getByRole('button', { name: 'All workspaces' }))
    const dialog = await screen.findByRole('dialog', { name: 'All workspaces' })
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent ?? '').map((t) => ['Proj', 'Other', 'New workspace…'].some((n) => t.includes(n)))).toEqual([true, true, true])
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'oth' } })
    fireEvent.click(within(dialog).getAllByRole('option')[0])
    expect(onSelect).toHaveBeenCalledWith('w2')
  })

  it('"New workspace…" in All workspaces opens the + menu', async () => {
    mount('tabs', { workspaces: [ws, mk('w2', 'Other')], railChrome: true })
    fireEvent.click(screen.getByRole('button', { name: 'All workspaces' }))
    const dialog = await screen.findByRole('dialog', { name: 'All workspaces' })
    fireEvent.click(within(dialog).getByRole('option', { name: /New workspace/ }))
    expect(await screen.findByRole('menuitem', { name: 'Clone Repository…' })).toBeTruthy()
  })

  it('is absent with a single workspace', () => {
    mount('tabs', { railChrome: true })
    expect(screen.queryAllByRole('button', { name: 'All workspaces' })).toHaveLength(0)
  })
})

describe('View > Header', () => {
  it.each(HEADER_MODES)('is a two-option radio group that shows the stored mode (%s) and sets the mode', (stored) => {
    setHeaderMode(stored)
    mount('tabs', { railChrome: false })
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Header' }))
    for (const m of HEADER_MODES) {
      const row = screen.getByRole('menuitemcheckbox', { name: new RegExp(m, 'i') })
      expect(row.getAttribute('aria-checked')).toBe(String(m === stored))
    }
    const target = HEADER_MODES.find((m) => m !== stored) as HeaderMode
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: new RegExp(target, 'i') }))
    expect(getHeaderMode()).toBe(target)
  })
})
