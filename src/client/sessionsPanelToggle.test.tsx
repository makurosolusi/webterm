/** @vitest-environment jsdom */
// Regression: group chevrons "stuck" (sometimes 3 clicks). Root: the select handler read the
// library's `open` lazily inside the setState updater; React defers the updater to render time when
// an update is already pending, by which point the library had flipped `open`, so the inverse was
// stored and the next render re-opened the group. These tests drive the library's protocol
// (select event fires BEFORE it flips `open`) with an update already pending.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import { __resetNodeStatusForTests } from './nodeStatus.store'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Workspace } from '../shared/workspace'

const ws = (id: string, name: string): Workspace => ({ id, name, viewport: DEFAULT_VIEWPORT, nodes: [{ id: `n-${id}`, kind: 'terminal', title: name, x: 0, y: 0 }], bridges: [], updatedAt: 0 })
const props = (): SessionsPanelProps => ({
  active: true, workspaces: [ws('p1', 'Alpha'), ws('p2', 'Beta')], activeId: 'p1', liveActiveNodes: null, statuses: {},
  onFocusNode: () => {}, onCloseSession: () => {}, onSelectWorkspace: () => {},
})
type Open = HTMLElement & { open: boolean }
const group = (id: string) => document.querySelector<Open>(`vscode-tree-item[data-group="project:${id}"]`) as Open
const saved = () => JSON.parse(localStorage.getItem('webterm.sessionsCollapsed') ?? '{}') as Record<string, boolean>

/** One chevron click as the library performs it: select event first, then flip `open`. */
function clickGroup(el: Open): void {
  document.querySelector('vscode-tree')!.dispatchEvent(new CustomEvent('vsc-tree-select', { detail: [el] }))
  el.open = !el.open
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); __resetNodeStatusForTests() })

describe('Sessions group toggle', () => {
  it('stores the intended fold for every click even when updates are batched', () => {
    render(<SessionsPanel {...props()} />)
    group('p1').open = true
    group('p2').open = true

    // Two clicks before React flushes: the second updater is deferred to render time.
    act(() => { clickGroup(group('p1')); clickGroup(group('p2')) })

    expect(saved()).toMatchObject({ 'project:p1': true, 'project:p2': true })
    expect(group('p1').open).toBe(false)
    expect(group('p2').open).toBe(false)
  })

  it('one click folds once, the second unfolds, and a data refresh keeps the state', () => {
    const { rerender } = render(<SessionsPanel {...props()} />)
    group('p2').open = true

    act(() => clickGroup(group('p2')))
    expect(group('p2').open).toBe(false)
    rerender(<SessionsPanel {...props()} statuses={{ 'n-p2': 'working' }} />)
    expect(group('p2').open).toBe(false)

    act(() => clickGroup(group('p2')))
    expect(group('p2').open).toBe(true)
    rerender(<SessionsPanel {...props()} statuses={{ 'n-p2': 'done' }} />)
    expect(group('p2').open).toBe(true)
  })

  it('Collapse all folds every group and a chevron can reopen one', () => {
    render(<SessionsPanel {...props()} />)
    act(() => { fireEvent.click(screen.getByLabelText('Collapse all')) })
    expect(group('p1').open).toBe(false)
    expect(group('p2').open).toBe(false)

    act(() => clickGroup(group('p1')))
    expect(group('p1').open).toBe(true)
    expect(group('p2').open).toBe(false)
  })
})
