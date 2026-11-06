/**
 * @vitest-environment jsdom
 */
// Workspace switching: the last click wins even when the GETs answer out of order.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLatestSelect } from './workspaceLifecycle.select'
import type { Workspace } from '../shared/workspace'

const api = vi.hoisted(() => ({ getWorkspace: vi.fn(), setActive: vi.fn() }))
vi.mock('./api', () => api)

const board = (id: string): Workspace => ({ id, name: id, cwd: '/', nodes: [], bridges: [], viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 1 })

/** A GET per board that answers only when the test says so; records whether it was aborted. */
function deferredGets() {
  const pending = new Map<string, { resolve: (ws: Workspace) => void; signal?: AbortSignal }>()
  api.getWorkspace.mockImplementation((id: string, signal?: AbortSignal) => new Promise<Workspace>((resolve, reject) => {
    pending.set(id, { resolve, signal })
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  return pending
}

function setup(shown: string) {
  const applyWorkspace = vi.fn()
  const setWorkspaces = vi.fn()
  const activeWsRef = { current: board(shown) }
  const { result } = renderHook(() => useLatestSelect({ activeWsRef, applyWorkspace, setWorkspaces }))
  return { result, applyWorkspace }
}

afterEach(cleanup)

beforeEach(() => {
  api.getWorkspace.mockReset()
  api.setActive.mockReset().mockResolvedValue(undefined)
})

describe('useLatestSelect', () => {
  it('B then C, B answering last: C stays on screen and the GET for B is aborted', async () => {
    const gets = deferredGets()
    const { result, applyWorkspace } = setup('A')
    let toB!: Promise<void>, toC!: Promise<void>
    act(() => { toB = result.current.onSelect('B'); toC = result.current.onSelect('C') })
    expect(gets.get('B')!.signal!.aborted).toBe(true)
    await act(async () => { gets.get('C')!.resolve(board('C')); await toC })
    await act(async () => { gets.get('B')!.resolve(board('B')); await toB })
    expect(applyWorkspace.mock.calls.map(([ws]) => ws.id)).toEqual(['C'])
    expect(api.setActive.mock.calls.map(([id]) => id)).toEqual(['C'])
  })

  it('B then back to A before B loads ends on A, on screen and on the server', async () => {
    const gets = deferredGets()
    const { result, applyWorkspace } = setup('A')
    let toB!: Promise<void>
    await act(async () => { toB = result.current.onSelect('B'); await result.current.onSelect('A') })
    await act(async () => { gets.get('B')!.resolve(board('B')); await toB })
    expect(applyWorkspace).not.toHaveBeenCalled()
    expect(api.setActive.mock.calls.map(([id]) => id)).toEqual(['A'])
  })

  it('a failed GET rejects with its cause so the caller can report it', async () => {
    api.getWorkspace.mockRejectedValue(new Error('GET /api/workspaces/B -> 500'))
    const { result, applyWorkspace } = setup('A')
    await expect(result.current.onSelect('B')).rejects.toThrow('-> 500')
    expect(applyWorkspace).not.toHaveBeenCalled()
  })
})
