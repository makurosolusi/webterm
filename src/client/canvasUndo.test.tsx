/**
 * @vitest-environment jsdom
 */
// `useCanvasUndo` decides between layout undo and reopen-closed. The canvas path is proven in
// `closedUndo.canvas.test.tsx`; this pins the after-reload branch (empty layout stack).
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCanvasUndo, type CanvasUndoDeps } from './canvasUndo'
import type { ClosedEntry } from './closedHistory'

const entry = (id: string, workspaceId: string): ClosedEntry => ({
  node: { id, kind: 'agent', x: 0, y: 0 }, workspaceId, workspaceName: workspaceId, closedAt: 1,
})

function deps(over: Partial<CanvasUndoDeps> = {}): CanvasUndoDeps {
  return {
    nodesRef: { current: [] },
    layout: { onUndo: vi.fn(), canUndo: false },
    closed: [],
    bridgesOf: vi.fn(() => []),
    reopen: vi.fn(async () => undefined),
    reopenDeps: { activeId: 'w1', addNode: vi.fn(), setWorkspaces: vi.fn(), selectWorkspace: vi.fn() },
    restoreBridges: vi.fn(),
    ...over,
  }
}

describe('useCanvasUndo', () => {
  it('after a reload (empty layout stack) Undo reopens the newest closed node of the ACTIVE workspace', () => {
    const d = deps({ closed: [entry('other', 'w2'), entry('mine', 'w1'), entry('older', 'w1')] })
    const { result } = renderHook(() => useCanvasUndo(d))
    expect(result.current.canUndo).toBe(true)
    act(() => result.current.onUndo())
    expect(d.reopen).toHaveBeenCalledWith('mine', d.reopenDeps)
    expect(d.layout.onUndo).not.toHaveBeenCalled()
  })

  it('nothing to undo and nothing closed here: Undo is disabled', () => {
    const { result } = renderHook(() => useCanvasUndo(deps({ closed: [entry('other', 'w2')] })))
    expect(result.current.canUndo).toBe(false)
  })

  it('a layout step wins and the cables of nodes it brought back are restored', () => {
    const nodesRef = { current: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }] }
    const cable = { id: 'e', source: 'a', target: 'b', kind: 'context' as const }
    const d = deps({
      nodesRef,
      layout: { canUndo: true, onUndo: vi.fn(() => { nodesRef.current = [...nodesRef.current, { id: 'b', position: { x: 0, y: 0 }, data: {} }] }) },
      bridgesOf: vi.fn(() => [cable]),
    })
    const { result } = renderHook(() => useCanvasUndo(d))
    act(() => result.current.onUndo())
    expect(d.bridgesOf).toHaveBeenCalledWith(['b'])
    expect(d.restoreBridges).toHaveBeenCalledWith([cable])
    expect(d.reopen).not.toHaveBeenCalled()
  })
})
