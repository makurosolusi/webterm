/** @vitest-environment jsdom */
// `useNodeStatusFactsMap`: one batched fetch for every listed id, and a snapshot that stays the same
// object until the facts change (useSyncExternalStore would loop on a fresh object per read).
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeStatusInfo } from '../shared/nodeStatusBar'
import { __resetNodeStatusForTests, useNodeStatusFactsMap } from './nodeStatus.store'

let reply: Record<string, NodeStatusInfo> = {}
const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ nodes: reply }), { status: 200 }))

beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => { cleanup(); __resetNodeStatusForTests(); fetchMock.mockClear(); vi.unstubAllGlobals() })

describe('useNodeStatusFactsMap', () => {
  it('fetches every id in one request and returns their facts', async () => {
    reply = { a: { live: true, statusSince: 5 }, b: { live: false, exit: { code: 0, reason: 'self', at: 9 } } }
    const { result } = renderHook(() => useNodeStatusFactsMap(['a', 'b'], true))
    await waitFor(() => expect(result.current.b?.exit?.code).toBe(0))
    expect(result.current.a).toEqual({ live: true, statusSince: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/node-status?ids=a,b')
  })

  it('keeps the same snapshot object across re-renders when nothing changed', async () => {
    reply = { a: { live: true } }
    const { result, rerender } = renderHook(({ ids }) => useNodeStatusFactsMap(ids, true), { initialProps: { ids: ['a'] } })
    await waitFor(() => expect(result.current.a?.live).toBe(true))
    const first = result.current
    rerender({ ids: ['a'] })
    expect(result.current).toBe(first)
  })

  it('disabled: no fetch, empty map', async () => {
    const { result } = renderHook(() => useNodeStatusFactsMap(['x'], false))
    await new Promise((r) => setTimeout(r, 600))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current).toEqual({})
  })
})
