/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const board = (id: string): Workspace => ({ id, name: id, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 1 }) // test-only

async function load(put: (ids: readonly string[]) => Promise<Workspace[]>, fetched: () => Promise<Workspace[]> = async () => []) {
  vi.resetModules()
  vi.doMock('./workspaceOrder.api', () => ({ putWorkspaceOrder: vi.fn(put) }))
  vi.doMock('./api', () => ({ fetchWorkspaces: vi.fn(fetched) }))
  return import('./workspaceOrder.save')
}
afterEach(() => { vi.doUnmock('./workspaceOrder.api'); vi.doUnmock('./api') })

describe('saveWorkspaceOrder', () => {
  test('one PUT, answer returned', async () => {
    const put = vi.fn(async (ids: readonly string[]) => ids.map(board))
    const { saveWorkspaceOrder } = await load(put)
    expect((await saveWorkspaceOrder(['b', 'a'])).map((w) => w.id)).toEqual(['b', 'a'])
    expect(put).toHaveBeenCalledTimes(1)
  })

  test('missing: refetches once and retries with the new workspace appended', async () => {
    const calls: string[][] = []
    const put = async (ids: readonly string[]) => {
      calls.push([...ids])
      if (calls.length === 1) throw new Error('PUT /api/workspaces/order -> 400: bad_order (missing)')
      return ids.map(board)
    }
    const { saveWorkspaceOrder } = await load(put, async () => [board('a'), board('b'), board('c')])
    await saveWorkspaceOrder(['b', 'a'])
    expect(calls).toEqual([['b', 'a'], ['b', 'a', 'c']])
  })

  test('a second failure is thrown with context, no third attempt', async () => {
    const put = vi.fn(async () => { throw new Error('PUT /api/workspaces/order -> 400: bad_order (missing)') })
    const { saveWorkspaceOrder } = await load(put, async () => [board('a')])
    await expect(saveWorkspaceOrder(['a'])).rejects.toThrow(/refreshing the list and saving again failed: .*bad_order \(missing\)/)
    expect(put).toHaveBeenCalledTimes(2)
  })

  test('other refusals are not retried', async () => {
    const put = vi.fn(async () => { throw new Error('PUT /api/workspaces/order -> 500') })
    const { saveWorkspaceOrder } = await load(put)
    await expect(saveWorkspaceOrder(['a'])).rejects.toThrow('-> 500')
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('wiring', () => {
  test('App hands the rail onReorder from useWorkspaceOrderSave (it was once left unwired)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/client/App.tsx', 'utf8')
    expect(src).toMatch(/const onReorder = useWorkspaceOrderSave\(setWorkspaces\)/)
    expect(src).toMatch(/workspaceRail: [^\n]*onRenameWorkspace, onReorder \}/)
  })
})

describe('reconcileOrder', () => {
  test('drops vanished ids and appends stored ones', async () => {
    const { reconcileOrder } = await load(async () => [])
    expect(reconcileOrder(['x', 'b', 'a'], [board('a'), board('b'), board('n')])).toEqual(['b', 'a', 'n'])
  })
})

describe('useWorkspaceOrderSave', () => {
  test('merges the answer into the list: server order, unsent edits of existing boards kept', async () => {
    const saved = ['b', 'a'].map((id) => ({ ...board(id), position: id === 'b' ? 0 : 1 }))
    const { useWorkspaceOrderSave } = await load(async () => saved)
    const { renderHook } = await import('@testing-library/react')
    let state = [{ ...board('a'), name: 'edited', position: 0 }, { ...board('b'), position: 1 }] as Workspace[]
    const set = (v: Workspace[] | ((p: Workspace[]) => Workspace[])) => { state = typeof v === 'function' ? v(state) : v }
    const { result } = renderHook(() => useWorkspaceOrderSave(set))
    await result.current(['b', 'a'])
    expect(state.map((w) => [w.id, w.name, (w as { position?: number }).position])).toEqual([['b', 'b', 0], ['a', 'edited', 1]])
  })
})
