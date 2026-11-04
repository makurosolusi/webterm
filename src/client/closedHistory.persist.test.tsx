/**
 * @vitest-environment jsdom
 *
 * "Recently closed" kini dipersist ke server (`/api/closed-history`). `fetch` dipalsukan sebagai
 * server kecil yang menyimpan body PUT terakhir; me-mount ulang hook = reload halaman.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useClosedHistory, type ClosedEntry } from './closedHistory'
import type { WsNode } from '../shared/workspace'

const ws = { id: 'w1', name: 'proj' }
const agent: WsNode = { id: 'a1', kind: 'agent', x: 4, y: 8, agentId: 'claude', sessionId: 'sid-1' }

function fakeServer(initial: ClosedEntry[] = [], gate?: Promise<void>) {
  const state = { stored: initial, puts: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/closed-history')
    if (init?.method === 'PUT') {
      state.puts++
      state.stored = (JSON.parse(String(init.body)) as { entries: ClosedEntry[] }).entries
      return new Response(null, { status: 204 })
    }
    await gate
    return new Response(JSON.stringify({ entries: state.stored }), { status: 200 })
  }))
  return state
}

afterEach(() => vi.unstubAllGlobals())

describe('useClosedHistory persistence', () => {
  it('a closed node survives a reload', async () => {
    const server = fakeServer()
    const first = renderHook(() => useClosedHistory([ws], []))
    await waitFor(() => expect(server.puts).toBe(1)) // load merges & writes back once
    act(() => first.result.current.record(['a1'], [agent], ws))
    await waitFor(() => expect(server.stored.map((e) => e.node.id)).toEqual(['a1']))
    first.unmount()

    const second = renderHook(() => useClosedHistory([ws], []))
    await waitFor(() => expect(second.result.current.entries.map((e) => e.node)).toEqual([agent]))
  })

  it('does not overwrite stored history with a partial list closed before the load finished', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const older: ClosedEntry = { node: { id: 'old', kind: 'terminal', x: 0, y: 0 }, workspaceId: 'w1', workspaceName: 'proj', closedAt: 1 }
    const server = fakeServer([older], gate)
    const hook = renderHook(() => useClosedHistory([ws], []))
    act(() => hook.result.current.record(['a1'], [agent], ws))
    expect(server.puts).toBe(0)
    release()
    await waitFor(() => expect(server.stored.map((e) => e.node.id)).toEqual(['a1', 'old']))
    expect(hook.result.current.entries.map((e) => e.node.id)).toEqual(['a1', 'old'])
  })

  it('reopen removes the entry from the stored copy too', async () => {
    const entry: ClosedEntry = { node: agent, workspaceId: 'w1', workspaceName: 'proj', closedAt: 5 }
    const server = fakeServer([entry])
    const hook = renderHook(() => useClosedHistory([ws], []))
    await waitFor(() => expect(hook.result.current.entries).toHaveLength(1))
    const addNode = vi.fn()
    await act(() => hook.result.current.reopen('a1', { activeId: 'w1', addNode, setWorkspaces: vi.fn(), selectWorkspace: vi.fn() }))
    expect(addNode.mock.calls[0][0]()).toEqual(agent)
    await waitFor(() => expect(server.stored).toEqual([]))
  })
})
