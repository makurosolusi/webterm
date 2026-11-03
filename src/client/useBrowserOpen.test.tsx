/** @vitest-environment jsdom */
// Pintu `openBrowserAt` lewat `useBoardActions` yang SUNGGUHAN (addFlowNode, persist, undo); hanya RF, status
// server, dan penyimpanan yang dipalsukan. Tanpa Chromium.
import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { Workspace } from '../shared/workspace'
import { FIT_MIN_ZOOM } from './browser.open.place'

const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./browser.feature', () => ({ useBrowserStatus: () => (feature.on ? {} : null) }))

import { useBoardActions } from './App.board'
import { useNodeActions } from './nodeActions'

const WS = { id: 'w', name: 'w', cwd: '/', nodes: [], bridges: [], viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0 } as Workspace
const term = (id: string, x: number, y: number): Node => ({ id, type: 'terminal', position: { x, y }, width: 400, height: 300, data: {} })
const URL_A = 'https://example.com/a'

// Satu hook yang mengembalikan board + nodes terkini.
function mount(initial: Node[], viewport = { x: 0, y: 0, zoom: 1 }) {
  const fit = vi.fn()
  const scheduleSave = vi.fn()
  const pushLayout = vi.fn()
  const fakeRf = { screenToFlowPosition: (p: { x: number; y: number }) => p, getViewport: () => viewport, fitView: fit }
  const hook = renderHook(() => {
    const [nodes, setNodes] = useState(initial)
    const nodesRef = useRef(initial)
    const rf = useRef(fakeRf as unknown as ReactFlowInstance)
    const activeWsRef = useRef<Workspace | null>(WS)
    const edgesRef = useRef([])
    const board = useBoardActions({
      rf, activeWsRef, nodesRef, edgesRef, settings: DEFAULT_SETTINGS, activeId: 'w', browserReady: true,
      setActiveWs: vi.fn(), setNodes, setEdges: vi.fn(), flushSave: vi.fn(), scheduleSave, resetViewport: vi.fn(),
      resetLayout: vi.fn(), pushLayout, recordClosed: vi.fn(),
    })
    return { board, nodes }
  })
  const open = (req: Parameters<NonNullable<typeof hook.result.current.board.nodeActions.openBrowserAt>>[0]) => {
    let res!: ReturnType<NonNullable<typeof hook.result.current.board.nodeActions.openBrowserAt>>
    act(() => { res = hook.result.current.board.nodeActions.openBrowserAt!(req) })
    return res
  }
  return { hook, open, fit, scheduleSave, pushLayout }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

beforeEach(() => { feature.on = true })
afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('useBrowserOpen via useBoardActions', () => {
  it('flag mati -> openBrowserAt undefined (pemicu tidak menampilkan aksi)', () => {
    feature.on = false
    const { hook } = mount([])
    expect(hook.result.current.board.nodeActions.openBrowserAt).toBeUndefined()
    expect(hook.result.current.board.onAddBrowser).toBeUndefined()
  })

  it('URL baru -> created: node browser 640x400 di kanan anchor, terpilih, dipersist + masuk undo', () => {
    const { hook, open, scheduleSave, pushLayout } = mount([term('t1', 100, 100)])
    const res = open({ url: URL_A, anchorNodeId: 't1' })
    expect(res.status).toBe('created')
    const nodes = hook.result.current.nodes
    expect(nodes).toHaveLength(2)
    const n = nodes[1]
    expect(res).toEqual({ status: 'created', nodeId: n.id })
    expect(n.type).toBe('browser')
    expect((n.data as { url?: string }).url).toBe(URL_A)
    expect([n.width, n.height]).toEqual([640, 400])
    expect(n.position).toEqual({ x: 100 + 400 + 32, y: 100 }) // kanan anchor + OPEN_GAP
    expect(n.selected).toBe(true)
    expect(scheduleSave).toHaveBeenCalledTimes(1)
    expect(pushLayout).toHaveBeenCalledTimes(1)
  })

  it('`at` eksplisit -> kiri-atas tepat di `at` (defaultSize, bukan size, yang dikompensasi)', () => {
    const { hook, open } = mount([])
    expect(DEFAULT_SETTINGS.defaultNodeHeight).not.toBe(400) // pembeda: salah pakai `size` akan menggeser y
    open({ url: URL_A, at: { x: 50, y: 70 } })
    expect(hook.result.current.nodes[0].position).toEqual({ x: 50, y: 70 })
  })

  it('URL sama kedua kali -> reused: jumlah node tetap, node lama terpilih, tanpa persist baru', () => {
    const { hook, open, scheduleSave, pushLayout } = mount([term('t1', 100, 100)])
    const first = open({ url: URL_A, anchorNodeId: 't1' })
    scheduleSave.mockClear(); pushLayout.mockClear()
    const second = open({ url: `${URL_A}#frag`, anchorNodeId: 't1' }) // fragmen tak membedakan
    expect(second).toEqual({ status: 'reused', nodeId: (first as { nodeId: string }).nodeId })
    const nodes = hook.result.current.nodes
    expect(nodes).toHaveLength(2)
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([second.status === 'reused' ? second.nodeId : ''])
    expect(scheduleSave).not.toHaveBeenCalled()
    expect(pushLayout).not.toHaveBeenCalled()
  })

  it('URL file: -> invalid, jumlah node tetap', () => {
    const { hook, open } = mount([term('t1', 0, 0)])
    expect(open({ url: 'file:///etc/passwd' })).toEqual({ status: 'invalid', reason: 'scheme' })
    expect(hook.result.current.nodes).toHaveLength(1)
  })

  it('node di luar pandangan -> fitView dengan minZoom > ZOOM_PAUSE_BELOW, lalu fokus ke wrapper node', async () => {
    const { open, fit } = mount([term('t1', 5000, 5000)])
    const res = open({ url: URL_A, anchorNodeId: 't1' })
    const wrapper = document.createElement('div')
    wrapper.className = 'react-flow__node'
    wrapper.dataset.id = (res as { nodeId: string }).nodeId
    wrapper.tabIndex = 0
    document.body.append(wrapper)
    await nextFrame()
    expect(fit).toHaveBeenCalledTimes(1)
    expect(fit.mock.calls[0][0]).toMatchObject({ nodes: [{ id: wrapper.dataset.id }], minZoom: FIT_MIN_ZOOM })
    expect(document.activeElement).toBe(wrapper)
  })

  it('node sudah terlihat penuh -> tidak fitView', async () => {
    const { open, fit } = mount([])
    open({ url: URL_A, at: { x: 10, y: 10 } })
    await nextFrame()
    expect(fit).not.toHaveBeenCalled()
  })

  it('identitas openBrowserAt dan nodeActions stabil antar render dengan input sama', () => {
    const { hook } = mount([])
    const a = hook.result.current.board.nodeActions
    hook.rerender()
    expect(hook.result.current.board.nodeActions).toBe(a)
    expect(hook.result.current.board.nodeActions.openBrowserAt).toBe(a.openBrowserAt)
  })
})

describe('NodeActions default', () => {
  it('context tanpa provider tidak punya openBrowserAt', () => {
    const { result } = renderHook(() => useNodeActions())
    expect(result.current.openBrowserAt).toBeUndefined()
  })
})
