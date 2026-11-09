/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { SetStateAction } from 'react'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'
import { addNewWorkspaces } from './workspaceList.push'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeWS.instances.push(this) }
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', FakeWS)

const board = (id: string, name: string): Workspace => ({ id, name, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 1 }) // test-only

/** ws.ts, the api and the notice store keep module state: a fresh registry per case. */
async function fresh(listed: () => Promise<Workspace[]>) {
  vi.resetModules()
  const notices: Array<{ title: string; message?: string }> = []
  vi.doMock('./workspaceSave.notice', () => ({ ACTION_NOTICE_KEY: 'action', showNotice: (_k: string, n: never) => { notices.push(n) } }))
  vi.doMock('./api', () => ({ fetchWorkspaces: vi.fn(listed) }))
  const ws = await import('./ws')
  const list = await import('./workspaceList.push')
  ws.subscribe('t1', () => {}, () => {}) // opens the shared socket
  const sock = FakeWS.instances[FakeWS.instances.length - 1]
  const frame = (m: object) => sock.onmessage!({ data: JSON.stringify(m) })
  return { list, notices, frame }
}

/** State setters that apply updaters to plain values, so the hook's effects can be asserted. */
function target(active: Workspace | null, workspaces: Workspace[]) {
  const s = { active, workspaces }
  return {
    s,
    t: {
      activeWsRef: { current: active },
      setActiveWs: vi.fn((v: SetStateAction<Workspace | null>) => { s.active = typeof v === 'function' ? v(s.active) : v }),
      setWorkspaces: vi.fn((v: SetStateAction<Workspace[]>) => { s.workspaces = typeof v === 'function' ? v(s.workspaces) : v }),
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('./api'); vi.doUnmock('./workspaceSave.notice') })

describe('addNewWorkspaces', () => {
  test('appends only the boards the list lacks, keeping existing entries; same array when none', () => {
    const dirty = { ...board('w1', 'One'), nodes: [{ id: 'n1', kind: 'terminal' as const, x: 0, y: 0 }] }
    const prev = [dirty]
    expect(addNewWorkspaces(prev, [board('w1', 'One'), board('w2', 'Two')])).toEqual([dirty, board('w2', 'Two')])
    expect(addNewWorkspaces(prev, [board('w1', 'Stale copy')])).toBe(prev)
  })
})

describe('useWorkspaceListPush', () => {
  test('t:workspaces refetches the list and adds the new board; the active board is not switched', async () => {
    const { list, frame } = await fresh(async () => [board('w1', 'One'), board('w2', 'Two')])
    const { s, t } = target(board('w1', 'One'), [board('w1', 'One')])
    renderHook(() => list.useWorkspaceListPush(t))
    frame({ t: 'workspaces' })
    await flush()
    expect(s.workspaces.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(t.setActiveWs).not.toHaveBeenCalled()
    expect(t.activeWsRef.current?.id).toBe('w1')
  })

  test('a failed refresh is reported, never thrown, and leaves the list alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { list, frame, notices } = await fresh(async () => { throw new Error('GET /api/workspaces -> 500') })
    const { s, t } = target(null, [board('w1', 'One')])
    renderHook(() => list.useWorkspaceListPush(t))
    frame({ t: 'workspaces' })
    await flush()
    expect(notices).toEqual([expect.objectContaining({ title: 'Could not refresh the workspace list.', message: 'GET /api/workspaces -> 500' })])
    expect(s.workspaces.map((w) => w.id)).toEqual(['w1'])
  })

  test('a canvas frame with name renames the mounted board (ref = next save payload, and header state)', async () => {
    const { list, frame } = await fresh(async () => [])
    const live = { ...board('w1', 'Old'), viewport: { x: 9, y: 9, zoom: 2 } }
    const { s, t } = target(live, [])
    renderHook(() => list.useWorkspaceListPush(t))
    frame({ t: 'canvas', workspaceId: 'w1', base: 1, updatedAt: 2, nodes: [], bridges: [], name: 'New' })
    expect(t.activeWsRef.current).toEqual({ ...live, name: 'New' })
    expect(s.active?.name).toBe('New')
  })

  test('a frame for another board, without name, or with the same name changes nothing', async () => {
    const { list } = await fresh(async () => [])
    const live = board('w1', 'Old')
    const { t } = target(live, [])
    const msg = { t: 'canvas' as const, workspaceId: 'w1', base: 1, updatedAt: 2, nodes: [], bridges: [] }
    expect(list.applyRenamePush(t, { ...msg, workspaceId: 'w2', name: 'X' })).toBe(false)
    expect(list.applyRenamePush(t, msg)).toBe(false)
    expect(list.applyRenamePush(t, { ...msg, name: 'Old' })).toBe(false)
    expect(t.activeWsRef.current).toBe(live)
    expect(t.setActiveWs).not.toHaveBeenCalled()
  })
})
