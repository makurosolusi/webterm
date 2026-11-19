/** @vitest-environment jsdom */
// The pinned rail ("Show labels"): per-device preference, the Settings checkbox and search entry, and the
// `Workspace: Next / Previous` commands (the keyboard path to a workspace in every header mode).
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { HeaderModeField, RAIL_LABELS_FIELD } from './SettingsHeaderMode'
import { RAIL_LABELS_ATTR, RAIL_LABELS_KEY, getRailLabels, reloadRailLabelsFromStorage, setRailLabels, toggleRailLabels, useRailLabelsAttribute } from './railLabels.store'
import { RAIL_LABELS_ID, WORKSPACE_NEXT_ID, WORKSPACE_PREV_ID, workspaceNavCommands } from './workspaceNav.commands'
import { SETTINGS_SEARCH_INDEX } from './settings.search'
import { reloadHeaderModeFromStorage } from './headerMode.store'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const mk = (id: string, name: string, position: number): Workspace =>
  ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0, color: 'red', colorShade: 'default', position }) as Workspace // test-only

beforeEach(() => {
  localStorage.clear()
  reloadHeaderModeFromStorage()
  reloadRailLabelsFromStorage()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute(RAIL_LABELS_ATTR) })

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
  it('walks the display order (by position) and wraps, in both header modes', () => {
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
