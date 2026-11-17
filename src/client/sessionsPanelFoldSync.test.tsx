/** @vitest-environment jsdom */
// Regression: the fold had two owners (library DOM, React state). Keyboard folds emit no event, so
// React never learned of them and the next render wrote the stale `open` back; a filter forced
// `open` so a chevron click was undone too. State is now the only owner and DOM changes flow in.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as GroupItem from './SessionGroupItem'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import { __resetNodeStatusForTests } from './nodeStatus.store'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Workspace } from '../shared/workspace'

// The `open` prop each group was last rendered with = the React-owned fold. DOM `open` is asserted only
// where jsdom applies it (the library's prop write is not reliable there; see report).
const opens: Record<string, boolean> = {}
vi.mock('./SessionGroupItem', async (orig) => {
  const m = await orig<typeof GroupItem>()
  return { ...m, SessionGroupItem: (p: GroupItem.SessionGroupItemProps) => { opens[p.groupKey] = p.open; return m.SessionGroupItem(p) } }
})

const ws = (id: string, name: string): Workspace => ({ id, name, viewport: DEFAULT_VIEWPORT, nodes: [{ id: `n-${id}`, kind: 'terminal', title: name, x: 0, y: 0 }], bridges: [], updatedAt: 0 })
const props = (): SessionsPanelProps => ({
  active: true, workspaces: [ws('p1', 'Alpha'), ws('p2', 'Beta')], activeId: 'p1', liveActiveNodes: null, statuses: {},
  onFocusNode: () => {}, onCloseSession: () => {}, onSelectWorkspace: () => {},
})
type Open = HTMLElement & { open: boolean }
const group = (id: string) => document.querySelector<Open>(`vscode-tree-item[data-group="project:${id}"]`) as Open
const saved = () => JSON.parse(localStorage.getItem('webterm.sessionsCollapsed') ?? '{}') as Record<string, boolean>
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
/** A keyboard fold: the library flips `open` in the DOM and emits nothing. */
const keyboardFold = async (el: Open, open: boolean) => { el.open = open; await flush() }
/** jsdom does not apply the `open` prop at mount (the old toggle tests do the same): start groups open, as in the browser. */
const openAll = async () => { for (const id of ['p1', 'p2']) group(id).open = true; await flush() }
const type = (v: string) => fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: v } })

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); __resetNodeStatusForTests(); vi.restoreAllMocks() })

describe('Sessions fold sync (DOM -> state)', () => {
  it('a keyboard fold survives later renders instead of reverting', async () => {
    const { rerender } = render(<SessionsPanel {...props()} />)
    await openAll()
    await keyboardFold(group('p1'), false)
    expect(saved()['project:p1']).toBe(true)
    rerender(<SessionsPanel {...props()} statuses={{ 'n-p1': 'working' }} />)
    rerender(<SessionsPanel {...props()} statuses={{ 'n-p1': 'done' }} />)
    await flush()
    expect(opens['project:p1']).toBe(false)
    await keyboardFold(group('p1'), true)
    rerender(<SessionsPanel {...props()} statuses={{ 'n-p1': 'failed' }} />)
    await flush()
    expect(opens['project:p1']).toBe(true)
    expect(saved()['project:p1']).toBe(false)
  })

  it('Collapse all still folds everything after a keyboard expand', async () => {
    render(<SessionsPanel {...props()} />)
    await openAll()
    await keyboardFold(group('p2'), false)
    await keyboardFold(group('p2'), true)
    act(() => { fireEvent.click(screen.getByLabelText('Collapse all')) })
    await flush()
    expect(opens).toMatchObject({ 'project:p1': false, 'project:p2': false })
  })

  it('does not loop: a fold costs a bounded number of saves and observers are disconnected on unmount', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { rerender, unmount } = render(<SessionsPanel {...props()} />)
    await openAll()
    const before = setItem.mock.calls.length
    await keyboardFold(group('p1'), false)
    for (let i = 0; i < 5; i++) rerender(<SessionsPanel {...props()} statuses={{ 'n-p1': i % 2 ? 'working' : 'done' }} />)
    await flush()
    expect(setItem.mock.calls.length - before).toBeLessThanOrEqual(2)
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('while filtering a fold is session-only; clearing the filter restores the saved folds', async () => {
    render(<SessionsPanel {...props()} />)
    await openAll()
    await keyboardFold(group('p2'), false) // saved preference: Beta folded
    type('a') // matches Alpha and Beta; filter forces groups open
    await flush()
    expect(opens).toMatchObject({ 'project:p1': true, 'project:p2': true })

    await keyboardFold(group('p1'), false) // chevron works during the filter
    expect(opens['project:p1']).toBe(false)
    expect(saved()).toEqual({ 'project:p2': true }) // preference untouched

    type('')
    await flush()
    expect(opens).toMatchObject({ 'project:p1': true, 'project:p2': false }) // filter fold gone, saved fold back
  })
})
