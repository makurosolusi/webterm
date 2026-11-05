/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionHistory from './SessionHistory'
import type { AgentSession } from './SessionHistory.api'
import type { Workspace } from '../shared/workspace'

/** Visible tooltip of `el` (focus opens it); the label is the tooltip, not a native `title`. */
const tipOf = (el: Element): string | null => {
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(el)
  return text
}

const ws = (id: string, cwd?: string): Workspace => ({ id, name: id, cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 0 })
const s = (i: number, over: Partial<AgentSession> = {}): AgentSession => ({
  agent: 'claude', id: `sess-${i}`, cwd: '/repo', title: `Prompt ${i}`, startedAt: 0, endedAt: 0, messageCount: 2, ...over,
})

function stubPages(pages: Record<string, { items: AgentSession[]; total: number; nextOffset: number | null }>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    const offset = new URL(url, 'http://x').searchParams.get('offset') ?? '0'
    return new Response(JSON.stringify(pages[offset]), { status: 200 })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SessionHistory panel', () => {
  it('lists workspace sessions, pages with Load more, and Resume opens a claude agent node with --resume id', async () => {
    const calls = stubPages({
      '0': { items: [s(1)], total: 2, nextOffset: 1 },
      '1': { items: [s(2)], total: 2, nextOffset: null },
    })
    const addNode = vi.fn()
    const active = ws('w1', '/repo')
    render(<SessionHistory open activeWs={active} workspaces={[active]} launch={{}}
      deps={{ activeId: 'w1', addNode, setWorkspaces: vi.fn(), selectWorkspace: vi.fn() }} />)

    await screen.findByText('Prompt 1')
    expect(calls[0]).toContain('cwd=%2Frepo')
    expect(tipOf(screen.getByRole('button', { name: 'Refresh agent history' }))).toBe('Refresh agent history')
    fireEvent.click(screen.getByText('Load more'))
    await screen.findByText('Prompt 2')
    expect(calls[1]).toContain('offset=1')
    expect(screen.queryByText('Load more')).toBeNull()

    fireEvent.click(screen.getByLabelText('Resume Prompt 2'))
    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(1))
    expect(addNode.mock.calls[0][0]()).toMatchObject({ kind: 'agent', agentId: 'claude', cmd: 'claude', sessionId: 'sess-2', cwd: '/repo' })
  })

  it('a session from another workspace is written there and that workspace is selected', async () => {
    stubPages({ '0': { items: [s(3, { cwd: '/other/pkg' })], total: 1, nextOffset: null } })
    const active = ws('w1', '/repo')
    const other = ws('w2', '/other')
    const selectWorkspace = vi.fn(async () => {})
    const addNode = vi.fn()
    render(<SessionHistory open activeWs={active} workspaces={[active, other]} launch={{}}
      deps={{ activeId: 'w1', addNode, setWorkspaces: vi.fn(), selectWorkspace }} />)
    fireEvent.click(screen.getByText('All'))
    await screen.findByText('Prompt 3')

    const writes: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(init?.method === 'PUT' ? {} : other), { status: 200 })
    }))
    fireEvent.click(screen.getByLabelText('Resume Prompt 3'))
    await waitFor(() => expect(selectWorkspace).toHaveBeenCalledWith('w2'))
    expect(addNode).not.toHaveBeenCalled()
    expect((writes[0] as Workspace).nodes[0]).toMatchObject({ kind: 'agent', sessionId: 'sess-3', cwd: '/other/pkg' })
  })

  it('renders nothing when the sidebar is closed', () => {
    stubPages({})
    const { container } = render(<SessionHistory open={false} activeWs={null} workspaces={[]} launch={{}}
      deps={{ activeId: null, addNode: vi.fn(), setWorkspaces: vi.fn(), selectWorkspace: vi.fn() }} />)
    expect(container.innerHTML).toBe('')
  })
})
