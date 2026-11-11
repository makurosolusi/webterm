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
    const q = createSaveQueue(hooks, { save: srv.save })
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
    const q = createSaveQueue(hooks, { save: srv.save })
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
    const q = createSaveQueue(hooks, { save: srv.save })
    void q.enqueue(board(10))
    await q.enqueue(board(10))
    expect(hooks.onMissing).toHaveBeenCalledWith('w1')
    expect(hooks.onMissing).toHaveBeenCalledTimes(1)
    expect(srv.sent).toEqual([10]) // the queued second save was dropped
    await q.enqueue(board(11)) // a later edit on the deleted board
    expect(srv.sent).toEqual([10])
    expect(srv.get()).toBeNull()
  })

  it('any other failure keeps the board dirty, reports the error state, and the next edit retries it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = vi.fn<(ws: Workspace) => Promise<Workspace>>()
      .mockRejectedValueOnce(httpError(500))
      .mockImplementation(async (ws) => ({ ...ws, updatedAt: ws.updatedAt + 1 }))
    const states: string[] = []
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn(), onState: (s) => states.push(s.kind) }, { save, retryDelay: () => 60_000 })
    await q.enqueue(board(10, 'first'))
    expect(q.getState()).toMatchObject({ kind: 'error', workspaceId: 'w1', message: 'PUT -> 500' })
    expect(q.isDirty()).toBe(true) // the failed board is not forgotten
    expect(err.mock.calls[0][0]).toContain('w1')
    await q.enqueue(board(10, 'second'))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].name).toBe('second')
    expect(q.getState()).toEqual({ kind: 'idle' })
    expect(q.isDirty()).toBe(false)
    expect(states).toEqual(['saving', 'error', 'saving', 'idle'])
    err.mockRestore()
  })

  it('a failed save is resent unchanged by retry() once the server is back, with no new edit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let up = false
    const sent: string[] = []
    const save = vi.fn(async (ws: Workspace) => {
      sent.push(ws.name)
      if (!up) throw new TypeError('Failed to fetch')
      return { ...ws, updatedAt: ws.updatedAt + 1 }
    })
    const onSaved = vi.fn()
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn(), onSaved }, { save, retryDelay: () => 60_000 })
    await q.enqueue(board(10, 'offline edit'))
    expect(q.getState().kind).toBe('error')
    up = true
    await q.retry()
    expect(sent).toEqual(['offline edit', 'offline edit'])
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'offline edit', updatedAt: 11 }), false)
    expect(q.getState()).toEqual({ kind: 'idle' })
    vi.restoreAllMocks()
  })

  it('retries automatically with backoff after a failure', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = vi.fn<(ws: Workspace) => Promise<Workspace>>()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockImplementation(async (ws) => ({ ...ws, updatedAt: ws.updatedAt + 1 }))
    const delays: number[] = []
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn() }, { save, retryDelay: (n) => { delays.push(n); return 1000 * 2 ** n } })
    await q.enqueue(board(10))
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([0, 1])
    expect(q.getState()).toEqual({ kind: 'idle' })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a payload locked while a save is in flight replaces the older unsent one (boards are cumulative)', async () => {
    const srv = fakeServer(10)
    const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn() }, { save: srv.save })
    void q.enqueue(board(10, 'a'))
    void q.enqueue(board(10, 'b'))
    await q.enqueue(board(10, 'c'))
    expect(srv.sent).toEqual([10, 11]) // 'a' in flight, then only the newest ('c')
    expect(srv.get()?.name).toBe('c')
  })

  it('a 401/403 stops automatic retry, keeps the payload, reports auth once, and a manual retry resends it', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let refuse = true
      const save = vi.fn(async (ws: Workspace) => {
        if (refuse) throw httpError(403)
        return { ...ws, updatedAt: ws.updatedAt + 1 }
      })
      const onAuth = vi.fn()
      const q = createSaveQueue({ onStale: vi.fn(), onMissing: vi.fn(), onAuth }, { save, retryDelay: () => 1000 })
      await q.enqueue(board(10, 'kept'))
      expect(q.getState()).toMatchObject({ kind: 'error', auth: true, retryAt: 0 })
      expect(q.isDirty()).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000) // no timer: a 403 is not retried on its own
      expect(save).toHaveBeenCalledTimes(1)
      await q.retry() // still refused: no second auth report
      expect(save).toHaveBeenCalledTimes(2)
      expect(onAuth).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
      refuse = false // signed in again
      await q.retry()
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ name: 'kept' })
      expect(q.isDirty()).toBe(false)
      expect(q.getState()).toEqual({ kind: 'idle' })
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})
