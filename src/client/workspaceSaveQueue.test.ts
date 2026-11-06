import { describe, expect, it, vi } from 'vitest'
import { createSaveQueue } from './workspaceSaveQueue'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

const board = (updatedAt: number, name = 'w'): Workspace =>
  ({ id: 'w1', name, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt }) // test-only
const httpError = (status: number, body?: unknown) => Object.assign(new Error(`PUT -> ${status}`), { status, body })

/** A fake server holding one versioned row, enforcing the same precondition as `Db.save`. */
function fakeServer(start: number) {
  let stored: Workspace | null = board(start)
  const sent: number[] = []
  const save = vi.fn(async (ws: Workspace) => {
    sent.push(ws.updatedAt)
    await Promise.resolve() // in flight across a tick, like a real request
    if (!stored) throw httpError(404)
    if (stored.updatedAt > ws.updatedAt) throw httpError(409, { code: 'stale', current: stored })
    stored = { ...ws, updatedAt: stored.updatedAt + 1 }
    return stored
  })
  return { save, sent, get: () => stored, set: (ws: Workspace | null) => { stored = ws } }
}

describe('createSaveQueue', () => {
  it('saves one at a time and bases each save on the version the server last confirmed', async () => {
    const srv = fakeServer(10)
    const hooks = { onStale: vi.fn(), onMissing: vi.fn() }
    const q = createSaveQueue(hooks, srv.save)
    // Both payloads were built from the board loaded at version 10 (the debounce locks payloads).
    void q.enqueue(board(10, 'a'))
    await q.enqueue(board(10, 'b'))
    expect(srv.sent).toEqual([10, 11])
    expect(srv.get()?.name).toBe('b')
    expect(hooks.onStale).not.toHaveBeenCalled()
  })

  it('a 409 hands back the current board once and drops the saves queued on the stale board', async () => {
    const srv = fakeServer(10)
    srv.set(board(20, 'other window'))
    const hooks = { onStale: vi.fn(), onMissing: vi.fn() }
    const q = createSaveQueue(hooks, srv.save)
    void q.enqueue(board(10, 'mine 1'))
    await q.enqueue(board(10, 'mine 2'))
    expect(hooks.onStale).toHaveBeenCalledTimes(1)
    expect(hooks.onStale.mock.calls[0][0]).toMatchObject({ name: 'other window', updatedAt: 20 })
    expect(srv.sent).toEqual([10]) // 'mine 2' never sent
    expect(srv.get()?.name).toBe('other window') // nothing overwritten
    // A save built on the reloaded board goes through.
    await q.enqueue(board(20, 'after reload'))
    expect(srv.get()?.name).toBe('after reload')
  })

  it('a 404 drops the save and every later one, reported once, instead of re-creating the board', async () => {
    const srv = fakeServer(10)
    srv.set(null)
    const hooks = { onStale: vi.fn(), onMissing: vi.fn() }
    const q = createSaveQueue(hooks, srv.save)
    void q.enqueue(board(10))
    await q.enqueue(board(10))
    expect(hooks.onMissing).toHaveBeenCalledWith('w1')
    expect(hooks.onMissing).toHaveBeenCalledTimes(1)
    expect(srv.sent).toEqual([10]) // the queued second save was dropped
    await q.enqueue(board(11)) // a later edit on the deleted board
    expect(srv.sent).toEqual([10])
    expect(srv.get()).toBeNull()
  })

  it('any other failure is logged with the workspace id and does not block later saves', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = vi.fn<(ws: Workspace) => Promise<Workspace>>()
      .mockRejectedValueOnce(httpError(500))
      .mockImplementation(async (ws) => ({ ...ws, updatedAt: ws.updatedAt + 1 }))
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn() }, save)
    await q.enqueue(board(10))
    await q.enqueue(board(10))
    expect(save).toHaveBeenCalledTimes(2)
    expect(err.mock.calls[0][0]).toContain('w1')
    err.mockRestore()
  })
})
