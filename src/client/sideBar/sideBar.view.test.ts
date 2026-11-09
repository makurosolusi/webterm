/** @vitest-environment jsdom */
// Side bar view containers: the activity-click rule, the stored view (bad value, refused storage),
// the three "View: Show …" commands, and the Sessions badge count.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VIEWPORT, type Workspace, type WsNode } from '../../shared/workspace'
import { sideBarViewCommands } from './sideBar.commands'
import { activityClick, parseSideBarView, SIDE_BAR_VIEW_KEY, useSideBarView, type SideBarView } from './sideBar.view'
import { sessionsAttentionCount } from './useAppSideBar'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('activityClick (VS Code view containers)', () => {
  it.each([
    [{ open: true, view: 'layers' }, 'layers', { open: false, view: 'layers' }], // shown view: hide, keep it
    [{ open: true, view: 'layers' }, 'sessions', { open: true, view: 'sessions' }], // other view: switch
    [{ open: false, view: 'history' }, 'history', { open: true, view: 'history' }], // hidden: reopen same
    [{ open: false, view: 'history' }, 'layers', { open: true, view: 'layers' }], // hidden: open other
  ] as const)('%o + %s → %o', (state, clicked, next) => {
    expect(activityClick(state, clicked)).toEqual(next)
  })
})

describe('stored view', () => {
  it('unknown or missing text falls back to Layers', () => {
    expect(parseSideBarView(null)).toBe('layers')
    expect(parseSideBarView('nodes')).toBe('layers')
    expect(parseSideBarView('history')).toBe('history')
  })

  it('persists the chosen view and reads it back', () => {
    localStorage.setItem(SIDE_BAR_VIEW_KEY, 'sessions')
    const { result, unmount } = renderHook(() => useSideBarView())
    expect(result.current[0]).toBe('sessions')
    act(() => result.current[1]('history'))
    expect(localStorage.getItem(SIDE_BAR_VIEW_KEY)).toBe('history')
    unmount()
    expect(renderHook(() => useSideBarView()).result.current[0]).toBe('history')
  })

  it('throwing storage: defaults to Layers and still switches in memory', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const { result } = renderHook(() => useSideBarView())
    expect(result.current[0]).toBe('layers')
    act(() => result.current[1]('sessions'))
    expect(result.current[0]).toBe('sessions')
  })
})

describe('View: Show … commands', () => {
  it('one per view, no default key, each selects its view', () => {
    const select = vi.fn<(v: SideBarView) => void>()
    const cmds = sideBarViewCommands(select)
    expect(cmds.map((c) => [c.id, c.label])).toEqual([
      ['view.layers', 'View: Show Layers'],
      ['view.sessionsList', 'View: Show Sessions'],
      ['view.agentHistory', 'View: Show Agent History'],
    ])
    expect(cmds.every((c) => c.defaultKey === undefined)).toBe(true)
    cmds.forEach((c) => c.run?.())
    expect(select.mock.calls.map(([v]) => v)).toEqual(['layers', 'sessions', 'history'])
  })
})

describe('Sessions badge', () => {
  // test-only fixtures
  const node = (id: string): WsNode => ({ id, kind: 'terminal', title: id, x: 0, y: 0 })
  const ws = (id: string, nodes: WsNode[]): Workspace => ({ id, name: id, viewport: DEFAULT_VIEWPORT, nodes, bridges: [], updatedAt: 0 })

  it('counts sessions waiting in OTHER workspaces only', () => {
    const all = [ws('open', [node('a')]), ws('other', [node('b'), node('c'), node('d')])]
    const statuses = { a: 'waiting', b: 'blocked', c: 'failed', d: 'working' } as const
    expect(sessionsAttentionCount(all, null, 'open', statuses)).toBe(2)
    expect(sessionsAttentionCount(all, null, 'open', {})).toBe(0)
  })
})
