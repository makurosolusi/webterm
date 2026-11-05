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
const editor = (x: number, y: number): Node => ({
  id: 'ed', type: 'editor', position: { x, y }, ...EDITOR_SIZE, data: { filePath: FILE },
})

function setup(initial: Node[], edges: Edge[] = []) {
  let nodes = initial
  const fitView = vi.fn()
  const rf = {
    getNodes: () => nodes,
    getEdges: () => edges,
    getNode: (id: string) => nodes.find((n) => n.id === id),
    setNodes: (u: (prev: Node[]) => Node[]) => { nodes = u(nodes) },
    addNodes: (n: Node) => { nodes = [...nodes, n] },
    addEdges: vi.fn(),
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
  return { result, fitView, wrapper, nodes: () => nodes }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('useFilesOpen.openFile reveal', () => {
  it('file sudah terbuka di luar pandangan -> satu-satunya terpilih, fitView, fokus ke editor', () => {
    const { result, fitView, wrapper, nodes } = setup([files('files-a', 0), files('files-b', 500), editor(5000, 5000)])
    const el = wrapper('ed')
    act(() => result.current.openFile(FILE, 'test.txt'))
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual(['ed'])
    expect(nodes().filter((n) => n.type === 'editor')).toHaveLength(1)
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView.mock.calls[0][0]).toMatchObject({ nodes: [{ id: 'ed' }] })
    expect(document.activeElement).toBe(el)
  })

  it('file sudah terbuka dan terlihat penuh -> tanpa fitView, tetap fokus', () => {
    const { result, fitView, wrapper } = setup([files('files-b', 0), editor(10, 10)])
    const el = wrapper('ed')
    act(() => result.current.openFile(FILE, 'test.txt'))
    expect(fitView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(el)
  })

  it('editor baru -> satu-satunya terpilih, lalu di-reveal setelah frame berikutnya', async () => {
    const { result, fitView, wrapper, nodes } = setup([files('files-b', 0)])
    act(() => result.current.openFile(FILE, 'test.txt'))
    const ed = nodes().find((n) => n.type === 'editor')!
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual([ed.id])
    const el = wrapper(ed.id)
    await nextFrame()
    // Default jsdom 1024x768; editor di x=452 lebar 660 melewati tepi kanan -> kamera pindah.
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(el)
  })
})
