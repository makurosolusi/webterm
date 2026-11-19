/** @vitest-environment jsdom */
// Inventory (docs/decisions/header-rail-layout.md): with the header and the rail mounted together, every
// workspace control stays reachable in Full, Compact and Hidden, tiles appear in Compact/Hidden only,
// and each workspace surface exists once. Plus the pinned rail ("Show labels") and the nav commands.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar from './WorkspaceBar'
import { WorkspaceRail } from './WorkspaceRail'
import { RailLayout, RailMenu } from './RailChrome'
import { HeaderModeField, RAIL_LABELS_FIELD } from './SettingsHeaderMode'
import { RAIL_LABELS_ATTR, RAIL_LABELS_KEY, getRailLabels, reloadRailLabelsFromStorage, setRailLabels, toggleRailLabels, useRailLabelsAttribute } from './railLabels.store'
import { RAIL_LABELS_ID, WORKSPACE_NEXT_ID, WORKSPACE_PREV_ID, workspaceNavCommands } from './workspaceNav.commands'
import { SETTINGS_SEARCH_INDEX } from './settings.search'
import { reloadHeaderModeFromStorage, type HeaderMode } from './headerMode.store'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const mk = (id: string, name: string, position: number): Workspace =>
  ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0, color: 'red', colorShade: 'default', position }) as Workspace // test-only
const WS = [mk('w1', 'Alpha', 0), mk('w2', 'Beta', 1)]
const MODES: readonly HeaderMode[] = ['full', 'compact', 'hidden']

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
  localStorage.clear()
  reloadHeaderModeFromStorage()
  reloadRailLabelsFromStorage()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute(RAIL_LABELS_ATTR) })

const railChrome = (p: { workspaces: Workspace[]; activeId: string }, mode: HeaderMode) => ({
  workspaces: p.workspaces, activeId: p.activeId, liveActiveNodes: [], statuses: {}, onNewWorkspace: vi.fn(), onDeleteWorkspace: vi.fn(), onToggleLayout: vi.fn(),
  showLogout: true, onOpenAccount: vi.fn(), onLogout: vi.fn(), layoutInRail: mode === 'hidden',
})

function mount(mode: HeaderMode) {
  const props = { workspaces: WS, activeId: 'w1', liveActiveNodes: [], statuses: {}, onSelect: vi.fn(), onRenameWorkspace: vi.fn(async () => undefined) }
  return render(
    <>
      <WorkspaceBar {...props} headerMode={mode} onNewWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} onSetWorkspaceColor={vi.fn()}
        onOpenPalette={vi.fn()} onToggleLayout={vi.fn()} showLogout onOpenAccount={vi.fn()} onLogout={vi.fn()} />
      {mode !== 'full' && <WorkspaceRail {...props} />}
      {/* Compact/Hidden: the menu (and Hidden's layout switch) are rail buttons; see headerRail.inventory.test.tsx for the full contract. */}
      {mode !== 'full' && <RailMenu {...railChrome(props, mode)} />}
      {mode !== 'full' && <RailLayout {...railChrome(props, mode)} />}
    </>,
  )
}

describe.each(MODES)('workspace controls in %s', (mode) => {
  it('every workspace is one tab (strip in Full, rail tile otherwise), never two', () => {
    mount(mode)
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['Workspace Alpha, color red', 'Workspace Beta, color red'])
    expect(document.querySelectorAll('.ws-tile').length).toBe(mode === 'full' ? 0 : 2)
    expect(screen.getAllByRole('tablist', { name: 'Workspaces' })).toHaveLength(1)
  })

  it('has one New workspace button and one Search, and tab menu rows reachable on a tab', () => {
    mount(mode)
    expect(screen.getAllByRole('button', { name: 'New workspace' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Search' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Toggle tab layout' })).toHaveLength(1)
    fireEvent.contextMenu(screen.getAllByRole('tab')[1])
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '')
    for (const row of ['Rename', 'Canvas Background…', 'Color…', 'Mute Notifications', 'Delete']) expect(rows, row).toContain(row)
  })

  it('File > Rename Workspace… edits the active workspace on whichever surface is drawn', () => {
    mount(mode)
    const open = mode !== 'full' ? () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Menu' })); fireEvent.click(screen.getByRole('menuitem', { name: 'File' })) } : () => fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename Workspace/ }))
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
})

describe('pinned rail (Show labels)', () => {
  it('persists per device and mirrors onto <html> only while a rail is mounted', () => {
    expect(getRailLabels()).toBe(false)
    const { unmount } = renderHook(() => useRailLabelsAttribute())
    expect(document.documentElement.hasAttribute(RAIL_LABELS_ATTR)).toBe(false)
    act(() => setRailLabels(true))
    expect(document.documentElement.getAttribute(RAIL_LABELS_ATTR)).toBe('on')
    expect(localStorage.getItem(RAIL_LABELS_KEY)).toBe('on')
    unmount()
    expect(document.documentElement.hasAttribute(RAIL_LABELS_ATTR)).toBe(false)
    reloadRailLabelsFromStorage()
    expect(getRailLabels()).toBe(true)
  })

  it('survives blocked storage (the choice lasts for the page)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    act(() => setRailLabels(true))
    expect(getRailLabels()).toBe(true)
    vi.restoreAllMocks()
  })

  it('is a checkbox in Settings > Appearance, in the search index, and a palette command toggles the same store', () => {
    render(<HeaderModeField />)
    const box = screen.getByRole('checkbox', { name: RAIL_LABELS_FIELD.label }) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(getRailLabels()).toBe(true)
    act(() => toggleRailLabels())
    expect(box.checked).toBe(false)
    expect(SETTINGS_SEARCH_INDEX.find((e) => e.field === 'rail-labels')).toMatchObject({ page: 'appearance', label: RAIL_LABELS_FIELD.label })
  })
})

describe('Workspace: Next / Previous', () => {
  it('walks the display order (by position) and wraps, in every mode', () => {
    const select = vi.fn()
    const cmds = workspaceNavCommands([mk('w1', 'Alpha', 1), mk('w2', 'Beta', 0)], 'w2', select)
    expect(cmds.map((c) => c.id)).toEqual([WORKSPACE_NEXT_ID, WORKSPACE_PREV_ID, RAIL_LABELS_ID])
    cmds[0].run?.()
    expect(select).toHaveBeenLastCalledWith('w1')
    cmds[1].run?.()
    expect(select).toHaveBeenLastCalledWith('w1')
    expect(cmds[0].defaultKey).toBe('Mod+Alt+ArrowDown')
    expect(cmds[1].defaultKey).toBe('Mod+Alt+ArrowUp')
  })
})
