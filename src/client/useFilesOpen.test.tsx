/** @vitest-environment jsdom */
// Buka file yang SUDAH terbuka sebagai editor (dari node files kedua) harus mengantar pengguna ke
// editor itu: satu-satunya yang terpilih, kamera pindah hanya bila perlu, dan fokus keyboard pindah.
// React Flow dipalsukan di batas `useReactFlow`; keputusan rencana (`planFileOpen`) tetap sungguhan.
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const rfMock = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@xyflow/react', () => ({ useReactFlow: () => rfMock.current }))

import { EDITOR_SIZE } from './fileOpen'
import { useFilesOpen } from './useFilesOpen'

const FILE = '/projects/wibu/test.txt'
const files = (id: string, x: number): Node => ({ id, type: 'files', position: { x, y: 0 }, width: 420, height: 320, data: {}, selected: true })
const editor = (x: number, y: number, data: Record<string, unknown> = {}): Node => ({
  id: 'ed', type: 'editor', position: { x, y }, ...EDITOR_SIZE, data: { filePath: FILE, ...data },
})
const OTHER = '/projects/wibu/other.ts'
const cable = (source: string, target: string): Edge => ({ id: `bridge-${source}-${target}`, source, target, data: { kind: 'file' } })

function setup(initial: Node[], initialEdges: Edge[] = [], { queued = false } = {}) {
  let nodes = initial
  let edges = initialEdges
  // queued = like the real `rf.addNodes/addEdges`: invisible to getNodes/getEdges until the commit.
  let pending: Array<() => void> = []
  const later = (fn: () => void) => { if (queued) pending.push(fn); else fn() }
  const fitView = vi.fn()
  const rf = {
    getNodes: () => nodes,
    getEdges: () => edges,
    getNode: (id: string) => nodes.find((n) => n.id === id),
    setNodes: (u: (prev: Node[]) => Node[]) => later(() => { nodes = u(nodes) }),
    addNodes: (n: Node) => later(() => { nodes = [...nodes, n] }),
    addEdges: (e: Edge) => later(() => { edges = [...edges, e] }),
    updateNodeData: (nid: string, patch: Record<string, unknown>) => {
      nodes = nodes.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patch } } : n))
    },
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    fitView,
  }
  rfMock.current = rf
  const { result } = renderHook(() =>
    useFilesOpen({ id: 'files-b', cwd: '/projects/wibu', swatch: '#fff', setNotice: vi.fn(), pendingSel: { current: null } }))
  const wrapper = (id: string) => {
    const el = document.createElement('div')
    el.className = 'react-flow__node'
    el.dataset.id = id
    el.tabIndex = 0
    document.body.append(el)
    return el
  }
  const flush = () => { pending.forEach((fn) => fn()); pending = [] }
  return { result, fitView, wrapper, flush, nodes: () => nodes, edges: () => edges }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('useFilesOpen.openFile reveal', () => {
  it('file sudah terbuka di luar pandangan -> satu-satunya terpilih, fitView, fokus ke editor', () => {
    const { result, fitView, wrapper, nodes } = setup([files('files-a', 0), files('files-b', 500), editor(5000, 5000)])
    const el = wrapper('ed')
    act(() => result.current.openFile(FILE, { focusEditor: true }))
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual(['ed'])
    expect(nodes().filter((n) => n.type === 'editor')).toHaveLength(1)
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView.mock.calls[0][0]).toMatchObject({ nodes: [{ id: 'ed' }] })
    expect(document.activeElement).toBe(el)
  })

  it('file sudah terbuka dan terlihat penuh -> tanpa fitView, tetap fokus', () => {
    const { result, fitView, wrapper } = setup([files('files-b', 0), editor(10, 10)])
    const el = wrapper('ed')
    act(() => result.current.openFile(FILE, { focusEditor: true }))
    expect(fitView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(el)
  })

  it('editor baru -> satu-satunya terpilih, lalu di-reveal setelah frame berikutnya', async () => {
    const { result, fitView, wrapper, nodes } = setup([files('files-b', 0)])
    act(() => result.current.openFile(FILE, { focusEditor: true }))
    const ed = nodes().find((n) => n.type === 'editor')!
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual([ed.id])
    const el = wrapper(ed.id)
    await nextFrame()
    // Default jsdom 1024x768; editor di x=452 lebar 660 melewati tepi kanan -> kamera pindah.
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(el)
  })
})

describe('useFilesOpen.openFile: one node per file', () => {
  const OTHER_2 = '/projects/wibu/third.md'
  const editors = (ns: Node[]) => ns.filter((n) => n.type === 'editor')
  const rectOf = (n: Node) => ({ ...n.position, width: n.width ?? 420, height: n.height ?? 320 })
  const overlap = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  const expectNoOverlap = (ns: Node[]) => {
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) expect(overlap(rectOf(ns[i]), rectOf(ns[j]))).toBe(false)
  }

  it('two files by single click -> two editor nodes, each with its own open cable', () => {
    const { result, nodes, edges } = setup([files('files-b', 0)])
    act(() => result.current.openFile(FILE, { focusEditor: false }))
    act(() => result.current.openFile(OTHER, { focusEditor: false }))
    const eds = editors(nodes())
    expect(eds.map((n) => n.data.filePath)).toEqual([FILE, OTHER])
    expect(edges().map((e) => e.target)).toEqual(eds.map((n) => n.id))
    expect(edges().every((e) => e.source === 'files-b' && (e.data as { kind: string }).kind === 'file')).toBe(true)
  })

  it('the same file twice -> one node, one cable', () => {
    const { result, nodes, edges } = setup([files('files-b', 0)])
    act(() => result.current.openFile(FILE, { focusEditor: false }))
    act(() => result.current.openFile(FILE, { focusEditor: false }))
    expect(editors(nodes())).toHaveLength(1)
    expect(edges()).toHaveLength(1)
  })

  it('regression (preview reuse): repeated single clicks never change the filePath of an existing node', () => {
    const { result, nodes } = setup([files('files-b', 0), editor(10, 900, { preview: true })], [cable('files-b', 'ed')])
    for (const p of [OTHER, OTHER_2, OTHER]) act(() => result.current.openFile(p, { focusEditor: false }))
    expect(nodes().find((n) => n.id === 'ed')!.data.filePath).toBe(FILE)
    expect(editors(nodes()).map((n) => n.data.filePath)).toEqual([FILE, OTHER, OTHER_2])
  })

  it('opened files overlap neither each other nor an existing node', () => {
    const blocker: Node = { id: 'blocker', type: 'terminal', position: { x: 452, y: 0 }, width: 400, height: 300, data: {} }
    const { result, nodes } = setup([files('files-b', 0), blocker])
    for (let i = 0; i < 6; i++) act(() => result.current.openFile(`/w/f${i}.ts`, { focusEditor: false }))
    expect(editors(nodes())).toHaveLength(6)
    expectNoOverlap(nodes())
  })

  it('rapid clicks before React Flow flushes addNodes: no shared spot, no twin node, no twin cable', () => {
    const { result, nodes, edges, flush } = setup([files('files-b', 0)], [], { queued: true })
    act(() => {
      result.current.openFile(FILE, { focusEditor: false })
      result.current.openFile(OTHER, { focusEditor: false })
      result.current.openFile(FILE, { focusEditor: false })
    })
    flush()
    expect(editors(nodes()).map((n) => n.data.filePath)).toEqual([FILE, OTHER])
    expect(edges()).toHaveLength(2)
    expectNoOverlap(nodes())
  })

  it('single click leaves focus and selection in Files; visible editor -> camera stays', () => {
    const { result, fitView, wrapper, nodes } = setup([files('files-b', 0), editor(10, 10)], [cable('files-b', 'ed')])
    const filesEl = wrapper('files-b')
    wrapper('ed')
    filesEl.focus()
    act(() => result.current.openFile(FILE, { focusEditor: false }))
    expect(fitView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(filesEl)
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual(['files-b'])
  })

  it('single click, editor off screen -> camera moves and keeps Files in view, focus stays', () => {
    const { result, fitView, wrapper } = setup([files('files-b', 0), editor(5000, 5000)], [cable('files-b', 'ed')])
    const filesEl = wrapper('files-b')
    wrapper('ed')
    filesEl.focus()
    act(() => result.current.openFile(FILE, { focusEditor: false }))
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView.mock.calls[0][0]).toMatchObject({ nodes: [{ id: 'ed' }, { id: 'files-b' }] })
    expect(document.activeElement).toBe(filesEl)
  })

  it('off-screen is judged against the canvas pane, not the window (sidebar open)', () => {
    const pane = document.createElement('div')
    pane.className = 'react-flow'
    pane.getBoundingClientRect = () => ({ width: 700, height: 768 }) as DOMRect
    document.body.append(pane)
    // Right edge 760: inside the 1024 jsdom window, past the 700 pane.
    const { result, fitView } = setup([files('files-b', 0), editor(100, 10)])
    act(() => result.current.openFile(FILE, { focusEditor: false }))
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('Enter/menu selects and focuses the new editor', async () => {
    const { result, wrapper, nodes } = setup([files('files-b', 0)])
    act(() => result.current.openFile(OTHER, { focusEditor: true }))
    const ed = editors(nodes())[0]
    const el = wrapper(ed.id)
    await nextFrame()
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual([ed.id])
    expect(document.activeElement).toBe(el)
  })
})
