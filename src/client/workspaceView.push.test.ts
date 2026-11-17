/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Workspace } from '../shared/workspace'

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

/** ws.ts and the notice store keep module state: a fresh registry per case. */
async function fresh() {
  vi.resetModules()
  const notices: Array<{ title: string; message?: string; actions?: Array<{ label: string }> }> = []
  vi.doMock('./workspaceSave.notice', () => ({ ACTION_NOTICE_KEY: 'action', showNotice: (_k: string, n: never) => { notices.push(n) } }))
  const ws = await import('./ws')
  const view = await import('./workspaceView.push')
  ws.subscribe('t1', () => {}, () => {}) // opens the shared socket
  const sock = FakeWS.instances[FakeWS.instances.length - 1]
  const frame = (m: object) => sock.onmessage!({ data: JSON.stringify(m) })
  return { ws, view, notices, frame }
}

function target(activeId: string | null) {
  const calls: string[] = []
  return {
    calls,
    t: {
      activeWsRef: { current: activeId ? ({ id: activeId } as Workspace) : null },
      onSelect: vi.fn(async (id: string) => { calls.push(`select:${id}`) }),
      onFocus: vi.fn(async (id: string) => { calls.push(`focus:${id}`) }),
      onFit: vi.fn(() => { calls.push('fit') }),
      setBoard: vi.fn((v: unknown) => { calls.push(`board:${String(v)}`) }),
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
afterEach(() => { vi.restoreAllMocks() })

describe('canvas.show (t:view)', () => {
  test('ws dispatches view frames to subscribers, and unsubscribe stops them', async () => {
    const { ws, frame } = await fresh()
    const got: unknown[] = []
    const off = ws.subscribeView((m) => got.push(m))
    frame({ t: 'view', workspaceId: 'w2', nodeId: 'n1' })
    off()
    frame({ t: 'view', workspaceId: 'w3' })
    expect(got).toEqual([{ t: 'view', workspaceId: 'w2', nodeId: 'n1' }])
  })

  test('another board: selects it, THEN focuses the node, then closes the overview', async () => {
    const { view, frame } = await fresh()
    const { t, calls } = target('w1')
    renderHook(() => view.useViewPush(t))
    frame({ t: 'view', workspaceId: 'w2', nodeId: 'n9' })
    await flush()
    expect(calls).toEqual(['select:w2', 'focus:n9', 'board:false'])
  })

  test('the board already on screen is not re-selected; no node still closes the overview', async () => {
    const { view } = await fresh()
    const { t, calls } = target('w1')
    await view.applyView(t, 'w1')
    expect(t.onSelect).not.toHaveBeenCalled()
    expect(t.onFocus).not.toHaveBeenCalled()
    expect(calls).toEqual(['board:false'])
  })

  test('fit: switches, closes the overview, THEN fits the board; without fit nothing is fitted', async () => {
    const { view, frame } = await fresh()
    const { t, calls } = target('w1')
    renderHook(() => view.useViewPush(t))
    frame({ t: 'view', workspaceId: 'w2', fit: true })
    await flush()
    expect(calls).toEqual(['select:w2', 'board:false', 'fit'])
    calls.length = 0
    await view.applyView(t, 'w1', 'n1')
    expect(t.onFit).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['focus:n1', 'board:false'])
  })

  test('a failed switch is reported with Retry, never swallowed, and does not focus', async () => {
    const { view, notices, frame } = await fresh()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { t } = target('w1')
    t.onSelect.mockRejectedValueOnce(new Error('GET /api/workspaces/w2 -> 404'))
    renderHook(() => view.useViewPush(t))
    frame({ t: 'view', workspaceId: 'w2', nodeId: 'n9' })
    await flush()
    expect(t.onFocus).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith('[webterm] show the workspace (w2) failed:', expect.any(Error))
    const shown = notices.at(-1)
    expect(notices).toHaveLength(1)
    expect(shown?.title).toBe('Could not show the workspace.')
    expect(shown?.message).toContain('404')
    expect(shown?.actions?.[0]?.label).toBe('Retry')
  })
})

describe('canvas.camera / workspace.switch (polite t:view)', () => {
  test('zoom and pan frames reach the viewport callbacks, clamped to the canvas limits', async () => {
    const { view } = await fresh()
    const { t } = target('w1')
    const onZoomTo = vi.fn()
    const onPanBy = vi.fn()
    await view.applyView({ ...t, onZoomTo, onPanBy }, 'w1', undefined, undefined, { zoom: 0.5 })
    await view.applyView({ ...t, onZoomTo, onPanBy }, 'w1', undefined, undefined, { zoom: 9 })
    await view.applyView({ ...t, onZoomTo, onPanBy }, 'w1', undefined, undefined, { pan: { dx: 30, dy: -20 } })
    await view.applyView({ ...t, onZoomTo, onPanBy }, 'w1', undefined, undefined, { pan: { dx: 1e9, dy: -1e9 } })
    expect(onZoomTo.mock.calls).toEqual([[50], [200]])
    expect(onPanBy.mock.calls).toEqual([[30, -20], [5000, -5000]])
  })

  test('a polite frame is dropped while the user moved the canvas, applied once they stopped; an impolite one (canvas.show) always applies', async () => {
    const { view, frame } = await fresh()
    const { noteUserActive, resetUserActivity } = await import('./userActivity')
    resetUserActivity()
    const { t } = target('w1')
    const onZoomTo = vi.fn()
    renderHook(() => view.useViewPush({ ...t, onZoomTo }))
    noteUserActive()
    frame({ t: 'view', workspaceId: 'w1', polite: true, zoom: 1 })
    frame({ t: 'view', workspaceId: 'w2', polite: true })
    await flush()
    expect(onZoomTo).not.toHaveBeenCalled()
    expect(t.onSelect).not.toHaveBeenCalled()
    frame({ t: 'view', workspaceId: 'w1', fit: true }) // canvas.show: the user asked, so it never yields
    await flush()
    expect(t.onFit).toHaveBeenCalledTimes(1)
    resetUserActivity() // nothing for this session: idle
    frame({ t: 'view', workspaceId: 'w1', polite: true, zoom: 1 })
    await flush()
    expect(onZoomTo).toHaveBeenCalledWith(100)
  })

  test('the follow controller counts as the same clock: a user move pauses polite frames', async () => {
    const { userIdleMs, resetUserActivity } = await import('./userActivity')
    resetUserActivity()
    const { createFollowController } = await import('./centralFollow')
    const ctl = createFollowController({ getRf: () => null, workspaceId: () => null, isHidden: () => false, isTabMode: () => false })
    expect(userIdleMs()).toBe(Infinity)
    ctl.userMoved('down')
    expect(userIdleMs()).toBe(0)
    ctl.userMoved('up')
    expect(userIdleMs()).toBeLessThan(1000)
    ctl.dispose()
    resetUserActivity()
  })
})
