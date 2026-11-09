/** @vitest-environment jsdom */
// Policy: in the Sessions view's Project tab a workspace group header ONLY expands/collapses.
// Bug it locks: a header click used to call `onSelectWorkspace`, so every attempt to expand a
// group jumped the whole app to that board.
// Switching lives in the header's inline action (and the context menu / a session row).
// `vsc-tree-select` is the event the library emits for both a click and Enter/Space on an item.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const ws = (id: string, name: string, nodeId: string): Workspace => ({
  id,
  name,
  viewport: DEFAULT_VIEWPORT,
  nodes: [{ id: nodeId, kind: 'terminal', title: `${name} shell`, x: 0, y: 0 }],
  bridges: [],
  updatedAt: 0,
})

const props = (onSelectWorkspace: (id: string) => void): SessionsPanelProps => ({
  active: true,
  workspaces: [ws('p0', 'Current', 'n0'), ws('noc', 'noc', 'n1')],
  activeId: 'p0',
  liveActiveNodes: null,
  statuses: {},
  onFocusNode: () => {},
  onCloseSession: () => {},
  onSelectWorkspace,
})

const header = () => {
  const el = document.querySelector<HTMLElement & { open?: boolean }>('vscode-tree-item[data-group="project:noc"]')
  if (!el) throw new Error('noc group header not rendered')
  return el
}
const emitSelect = (el: Element) =>
  document.querySelector('vscode-tree')?.dispatchEvent(new CustomEvent('vsc-tree-select', { detail: [el] }))

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('workspace group header never switches workspace', () => {
  it('click (select) on the header only toggles collapse', async () => {
    const onSelectWorkspace = vi.fn()
    render(<SessionsPanel {...props(onSelectWorkspace)} />)
    header().open = false
    emitSelect(header())
    expect(onSelectWorkspace).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('webterm.sessionsCollapsed') ?? '{}')['project:noc']).toBe(false),
    )
  })

  it('Enter and Space on the header only toggle collapse', () => {
    const onSelectWorkspace = vi.fn()
    render(<SessionsPanel {...props(onSelectWorkspace)} />)
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(header(), { key })
      emitSelect(header())
    }
    expect(onSelectWorkspace).not.toHaveBeenCalled()
  })

  it('the inline Switch to Workspace action switches exactly once, with a tooltip and no native title', () => {
    const onSelectWorkspace = vi.fn()
    render(<SessionsPanel {...props(onSelectWorkspace)} />)
    const action = screen.getByLabelText('Switch to Workspace noc')
    expect(action.getAttribute('slot')).toBe('actions')
    expect(action.hasAttribute('title')).toBe(false)
    fireEvent.keyDown(document, { key: 'Tab' })
    fireEvent.focus(action)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Switch to Workspace')
    fireEvent.blur(action)

    fireEvent.click(action)
    expect(onSelectWorkspace).toHaveBeenCalledTimes(1)
    expect(onSelectWorkspace).toHaveBeenCalledWith('noc')

    fireEvent.keyDown(action, { key: 'Enter' })
    expect(onSelectWorkspace).toHaveBeenCalledTimes(2)
  })

  it('the current workspace header has no Switch to Workspace action', () => {
    render(<SessionsPanel {...props(vi.fn())} />)
    expect(screen.queryByLabelText('Switch to Workspace Current')).toBeNull()
    expect(screen.getByLabelText('Switch to Workspace noc')).toBeTruthy()
  })
})
