/** @vitest-environment jsdom */
// "Show in Files" di header editor: muncul hanya bila ada kabel file hidup ke editor ini, dan klik
// mengantar pengguna ke node Files asalnya (satu-satunya terpilih, kamera hanya bila perlu, fokus).
// React Flow dipalsukan di batas `useReactFlow`/`useStore`; selector & reveal tetap sungguhan.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const rfMock = vi.hoisted(() => ({ rf: null as unknown, state: null as unknown }))
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => rfMock.rf,
  useStore: (sel: (s: unknown) => unknown) => sel(rfMock.state),
}))

import { ShowInFilesButton } from './ShowInFilesButton'

const files = (id: string, x: number): Node => ({ id, type: 'files', position: { x, y: 0 }, width: 420, height: 320, data: {} })
const editor: Node = { id: 'ed', type: 'editor', position: { x: 0, y: 400 }, width: 300, height: 200, data: {}, selected: true }
const fileEdge = (src: string): Edge => ({ id: `bridge-${src}-ed`, source: src, target: 'ed', type: 'context', data: { kind: 'file' } })

function setup(initial: Node[], edges: Edge[]) {
  let nodes = initial
  const fitView = vi.fn()
  rfMock.rf = {
    getNode: (id: string) => nodes.find((n) => n.id === id),
    setNodes: (u: (prev: Node[]) => Node[]) => { nodes = u(nodes) },
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    fitView,
  }
  rfMock.state = { edges, nodeLookup: new Map(nodes.map((n) => [n.id, n])) }
  const wrapper = (id: string) => {
    const el = document.createElement('div')
    el.className = 'react-flow__node'
    el.dataset.id = id
    el.tabIndex = 0
    document.body.append(el)
    return el
  }
  render(<ShowInFilesButton editorId="ed" />)
  return { fitView, wrapper, nodes: () => nodes }
}

const button = () => screen.queryByRole('button', { name: 'Show in Files' })

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('ShowInFilesButton', () => {
  it('tersembunyi tanpa kabel file (kabel context biasa tidak dihitung)', () => {
    setup([files('f', 0), editor], [{ ...fileEdge('f'), data: { kind: 'context' } }])
    expect(button()).toBeNull()
  })

  it('tersembunyi bila node Files sumber kabel sudah tidak ada', () => {
    setup([editor], [fileEdge('gone')])
    expect(button()).toBeNull()
  })

  it('di luar pandangan -> Files satu-satunya terpilih, fitView ke Files, fokus pindah', () => {
    const { fitView, wrapper, nodes } = setup([files('f', 5000), editor], [fileEdge('f')])
    const el = wrapper('f')
    act(() => { fireEvent.click(button()!) })
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual(['f'])
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView.mock.calls[0][0]).toMatchObject({ nodes: [{ id: 'f' }] })
    expect(document.activeElement).toBe(el)
  })

  it('terlihat penuh -> tanpa fitView, tetap fokus', () => {
    const { fitView, wrapper } = setup([files('f', 10), editor], [fileEdge('f')])
    const el = wrapper('f')
    act(() => { fireEvent.click(button()!) })
    expect(fitView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(el)
  })

  it('dua Files tertaut -> kabel terbaru (terakhir) yang menang', () => {
    const { nodes, wrapper } = setup([files('old', 0), files('new', 10), editor], [fileEdge('old'), fileEdge('new')])
    wrapper('new')
    act(() => { fireEvent.click(button()!) })
    expect(nodes().filter((n) => n.selected).map((n) => n.id)).toEqual(['new'])
  })
})
