/** @vitest-environment jsdom */
// Policy: the Sessions view's Project tab lists EVERY workspace, in tab order, and a board switch
// only moves the Current mark. Bug it locks: the tab used to leave the open workspace out, so a
// row click (which switches board to that row's workspace) swapped which groups were listed and
// the list flipped between "laya-api" and "noc" on every click.
// Also: a Recently closed row asks (`confirmReopen`) before reopening onto ANOTHER board.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionsPanel, { type SessionsPanelProps } from './SessionsPanel'
import { __resetNodeStatusForTests } from './nodeStatus.store'
import { confirmReopen } from './reopenConfirm'
import type { ClosedEntry } from './closedHistory'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

vi.mock('./reopenConfirm', () => ({ confirmReopen: vi.fn() }))

// test-only fixtures
const ws = (id: string, name: string, nodeId: string, cwd: string): Workspace => ({
  id, name, cwd, viewport: DEFAULT_VIEWPORT, bridges: [], updatedAt: 0,
  nodes: [{ id: nodeId, kind: 'terminal', title: `${name} shell`, x: 0, y: 0 }],
})
const A = ws('pa', 'laya-api', 'a1', '/dev/laya-api')
const B = ws('pb', 'noc', 'b1', '/dev/noc')
const CLOSED: ClosedEntry = {
  node: { id: 'old1', kind: 'terminal', title: 'Old', x: 0, y: 0 }, workspaceId: 'pb', workspaceName: 'noc', closedAt: 1,
}

const props = (over: Partial<SessionsPanelProps> = {}): SessionsPanelProps => ({
  active: true, workspaces: [A, B], activeId: 'pa', liveActiveNodes: null, statuses: {},
  onFocusNode: vi.fn(), onCloseSession: vi.fn(), onSelectWorkspace: vi.fn(), ...over,
})

const groups = () =>
  [...document.querySelectorAll('vscode-tree-item[data-group^="project:"]')].map((g) => ({
    key: g.getAttribute('data-group'),
    current: g.getAttribute('aria-current') === 'true' && g.querySelector('.ss-ws__chip')?.textContent === 'Current',
  }))
const emitSelect = (el: Element) =>
  document.querySelector('vscode-tree')?.dispatchEvent(new CustomEvent('vsc-tree-select', { detail: [el] }))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    results: [
      { path: '/dev/laya-api', state: 'repo', repo: { branch: 'main' } },
      { path: '/dev/noc', state: 'not-a-repo', repo: null },
    ],
  }))))
})
afterEach(() => {
  cleanup()
  __resetNodeStatusForTests()
  vi.unstubAllGlobals()
  vi.mocked(confirmReopen).mockReset()
})

describe('Project tab is stable across a board switch', () => {
  it('lists A, B in order with A Current; after switching to B, same order with B Current', () => {
    const { rerender } = render(<SessionsPanel {...props()} />)
    expect(groups()).toEqual([{ key: 'project:pa', current: true }, { key: 'project:pb', current: false }])

    rerender(<SessionsPanel {...props({ activeId: 'pb' })} />)
    expect(groups()).toEqual([{ key: 'project:pa', current: false }, { key: 'project:pb', current: true }])
  })

  it('a row click focuses the node and the list keeps every group', () => {
    const onFocusNode = vi.fn()
    const { rerender } = render(<SessionsPanel {...props({ onFocusNode })} />)
    const row = document.querySelector('vscode-tree-item[aria-label^="noc shell"]')
    if (!row) throw new Error('noc row not rendered')
    emitSelect(row)
    expect(onFocusNode).toHaveBeenCalledWith('b1')
    rerender(<SessionsPanel {...props({ onFocusNode, activeId: 'pb' })} />)
    expect(groups().map((g) => g.key)).toEqual(['project:pa', 'project:pb'])
    expect(document.querySelector('vscode-tree-item[aria-label^="laya-api shell"]')).not.toBeNull()
  })

  it('header second line: folder, plus the branch from one git info request', async () => {
    render(<SessionsPanel {...props()} />)
    const subs = () => [...document.querySelectorAll('.ss-ws__sub')].map((s) => s.textContent)
    await waitFor(() => expect(subs()).toEqual(['laya-api · main', 'noc']))
    // One git info request; the node-status facts fetch (`/api/node-status`) is a separate store.
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).startsWith('/api/node-status'))).toHaveLength(1)
  })
})

describe('Recently closed row asks before reopening', () => {
  const clickClosed = (onReopenSession: (id: string) => void) => {
    render(<SessionsPanel {...props({ closedSessions: [CLOSED], onReopenSession })} />)
    const row = document.querySelector('vscode-tree-item[aria-label="Reopen Old"]')
    if (!row) throw new Error('closed row not rendered')
    emitSelect(row)
  }

  it('same board: reopens straight away, no confirm (undo exists)', async () => {
    const onReopenSession = vi.fn()
    render(<SessionsPanel {...props({ activeId: 'pb', closedSessions: [CLOSED], onReopenSession })} />)
    const row = document.querySelector('vscode-tree-item[aria-label="Reopen Old"]')
    if (!row) throw new Error('closed row not rendered')
    emitSelect(row)
    expect(onReopenSession).toHaveBeenCalledWith('old1')
    expect(confirmReopen).not.toHaveBeenCalled()
  })

  it('declined: does not reopen', async () => {
    vi.mocked(confirmReopen).mockResolvedValue(false)
    const onReopenSession = vi.fn()
    clickClosed(onReopenSession)
    await waitFor(() => expect(confirmReopen).toHaveBeenCalledWith(CLOSED, 'pa'))
    await Promise.resolve()
    expect(onReopenSession).not.toHaveBeenCalled()
  })

  it('confirmed: reopens that session', async () => {
    vi.mocked(confirmReopen).mockResolvedValue(true)
    const onReopenSession = vi.fn()
    clickClosed(onReopenSession)
    await waitFor(() => expect(onReopenSession).toHaveBeenCalledWith('old1'))
  })
})
