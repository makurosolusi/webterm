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
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
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
    render(<SessionHistory active activeWs={active} workspaces={[active]}
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
    render(<SessionHistory active activeWs={active} workspaces={[active, other]}
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

  it('inactive view renders nothing and does not fetch', () => {
    const calls = stubPages({})
    const { container } = render(<SessionHistory active={false} activeWs={null} workspaces={[]}
      deps={{ activeId: null, addNode: vi.fn(), setWorkspaces: vi.fn(), selectWorkspace: vi.fn() }} />)
    expect(container.innerHTML).toBe('')
    expect(calls).toEqual([])
  })

  it('becoming active fetches once and shows the toolbar, with no collapse header', async () => {
    const calls = stubPages({ '0': { items: [s(1)], total: 1, nextOffset: null } })
    const active = ws('w1', '/repo')
    const deps = { activeId: 'w1', addNode: vi.fn(), setWorkspaces: vi.fn(), selectWorkspace: vi.fn() }
    const { container, rerender } = render(<SessionHistory active={false} activeWs={active} workspaces={[active]} deps={deps} />)
    rerender(<SessionHistory active activeWs={active} workspaces={[active]} deps={deps} />)
    await screen.findByText('Prompt 1')
    expect(calls).toHaveLength(1)
    expect(container.querySelector('.agent-history-view')).not.toBeNull()
    expect(container.querySelector('[aria-expanded]')).toBeNull()
    expect(screen.queryByText(/agent history/i)).toBeNull()
    expect(screen.getByRole('radio', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'All' })).toBeTruthy()
    expect(screen.getByLabelText('Search sessions')).toBeTruthy()
    expect(screen.getByText('1 shown · 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh agent history' })).toBeTruthy()
    expect(container.querySelector('.agent-history__body')?.classList.contains('nowheel')).toBe(true)
  })

  it('empty, no-folder, no-match and error-with-retry states', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (fail) return new Response('boom', { status: 500 })
      const q = new URL(url, 'http://x').searchParams.get('q')
      return new Response(JSON.stringify({ items: [], total: 0, nextOffset: null, q }), { status: 200 })
    }))
    const deps = { activeId: 'w1', addNode: vi.fn(), setWorkspaces: vi.fn(), selectWorkspace: vi.fn() }
    const active = ws('w1', '/repo')
    const { rerender } = render(<SessionHistory active activeWs={active} workspaces={[active]} deps={deps} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load agent history.')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('No agent sessions found here yet.')
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'zzz' } })
    await screen.findByText('No sessions match “zzz”.', {}, { timeout: 2000 })

    const bare = ws('w1')
    rerender(<SessionHistory active activeWs={bare} workspaces={[bare]} deps={deps} />)
    expect(screen.getByText(/This workspace has no folder/)).toBeTruthy()
  })
})
