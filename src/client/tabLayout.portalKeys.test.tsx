/** @vitest-environment jsdom */
// Keys typed in a popup that a node opens into a portal (model picker, Select, any createPortal)
// must not reach React Flow's NodeWrapper keyboard a11y, which moves a selected node on arrows and
// toggles selection on Enter/Escape. Guarded once in `withTabPortal`, the wrapper of every node type.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ReactFlow, applyNodeChanges, type Node, type NodeChange, type NodeProps } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom } from './canvasHarness'
import { withTabPortal } from './tabLayout.portal'
import { connectTabLayout } from './tabLayout.store'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import { ModelPicker } from './agentChat/modelPicker'
import type { AgentChatModel } from '../shared/agentChat.wire'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
g.IS_REACT_ACT_ENVIRONMENT = true

const MODELS: AgentChatModel[] = [ // test-only
  { value: 'default', displayName: 'Default' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
]

const PickerNode = withTabPortal(function PickerNode() {
  return <div style={{ width: 200, height: 100 }}><ModelPicker loadModels={async () => MODELS} value="default" onChange={async () => undefined} /></div>
})
const PlainPortalNode = withTabPortal(function PlainPortalNode() {
  return <div style={{ width: 200, height: 100 }}>{createPortal(<button type="button">in portal</button>, document.body)}</div>
})
const types = { picker: PickerNode, plain: PlainPortalNode }

let current: Node[] = []
function Flow({ type }: { type: keyof typeof types }) {
  const [nodes, setNodes] = useState<Node[]>([{ id: 'n1', type, position: { x: 100, y: 100 }, selected: true, data: {} }])
  current = nodes
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodeTypes={types} nodes={nodes} edges={[]} onNodesChange={(c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns))} />
    </div>
  )
}
const node = () => current[0]
const wrapper = () => document.querySelector('.react-flow__node[data-id="n1"]') as HTMLElement

beforeAll(() => {
  installCanvasDom()
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
  connectTabLayout(defaultTabLayout(), null)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function mount(type: keyof typeof types): Promise<void> {
  render(<Flow type={type} />)
  await waitFor(() => expect(wrapper()).not.toBeNull())
  await act(() => new Promise<void>((r) => setTimeout(r, 5)))
}

describe('keys from a portaled popup inside a node', () => {
  it('model picker: arrows move the menu highlight, not the node; Enter/Escape do not touch selection', async () => {
    await mount('picker')
    fireEvent.keyDown(screen.getByRole('button', { name: /^Model:/ }), { key: 'Enter' })
    const items = await screen.findAllByRole('menuitemradio')
    expect(wrapper().contains(items[0])).toBe(false) // really portaled out of the node
    act(() => items[0].focus())
    // Radix roving focus moves the highlight in a timeout, hence waitFor.
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(items[1]))
    fireEvent.keyDown(items[1], { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(items[2]))
    fireEvent.keyDown(items[2], { key: 'ArrowUp' })
    await waitFor(() => expect(document.activeElement).toBe(items[1]))
    expect(node().position).toEqual({ x: 100, y: 100 })
    fireEvent.keyDown(items[1], { key: 'Enter' })
    expect(node().selected).toBe(true)
    expect(node().position).toEqual({ x: 100, y: 100 })
  })

  it('Escape in the open menu closes it and leaves the node selected', async () => {
    await mount('picker')
    fireEvent.keyDown(screen.getByRole('button', { name: /^Model:/ }), { key: 'Enter' })
    const items = await screen.findAllByRole('menuitemradio')
    fireEvent.keyDown(items[0], { key: 'Escape' })
    await waitFor(() => expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0))
    expect(node().selected).toBe(true)
  })

  it('plain React portal child: arrows / Enter / Escape never reach the NodeWrapper', async () => {
    await mount('plain')
    const btn = screen.getByRole('button', { name: 'in portal' })
    expect(wrapper().contains(btn)).toBe(false)
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowDown']) fireEvent.keyDown(btn, { key }) // no opposite pair: they would cancel out
    expect(node().position).toEqual({ x: 100, y: 100 })
    for (const key of ['Enter', ' ', 'Escape']) fireEvent.keyDown(btn, { key })
    expect(node().selected).toBe(true)
  })

  it('focus on the node itself: keyboard a11y still moves the selected node', async () => {
    await mount('plain')
    fireEvent.keyDown(wrapper(), { key: 'ArrowDown' })
    await waitFor(() => expect(node().position.y).toBeGreaterThan(100))
    expect(node().position.x).toBe(100)
  })
})
