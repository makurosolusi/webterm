/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActMsg } from '../shared/protocol'
import { resetSharedActStore } from './centralAct.store'
import { dispatchBroadcast } from './ws.listeners'

// ViewportPortal needs a mounted viewport element; render its children inline so the chip is visible.
// `getInternalNode` is the store lookup the chip prefers for the node's absolute position.
const internals = vi.hoisted(() => ({ lookup: (_id: string): unknown => undefined }))
vi.mock('@xyflow/react', async (orig) => {
  const actual = await orig<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReactFlow: () => ({ getInternalNode: (id: string) => internals.lookup(id) }),
  }
})

import CentralActMount, { absoluteNodePosition } from './centralAct.layer'

const touch = (nodeId: string): ActMsg => ({ t: 'act', v: 1, tool: 'canvas.type', verb: 'typed', nodeId, n: 1 })
const rfRef = { current: { getViewport: () => ({ x: 0, y: 0, zoom: 1 }), fitView: vi.fn(), getNode: () => undefined } as unknown as ReactFlowInstance }

const group: Node = { id: 'g', position: { x: 100, y: 200 }, data: {} }
const child: Node = { id: 'c', parentId: 'g', position: { x: 10, y: 20 }, data: {} }
const loner: Node = { id: 'n', position: { x: 7, y: 9 }, data: {} }

function chipStyle(nodes: Node[], nodeId: string): { left: string; top: string } {
  localStorage.setItem('webterm.centralFollow', 'off')
  const { container } = render(<CentralActMount rf={rfRef} nodes={nodes} workspaceId="w1" />)
  act(() => { dispatchBroadcast(touch(nodeId)) })
  const chip = container.querySelector<HTMLElement>('.central-act-chip')!
  return { left: chip.style.left, top: chip.style.top }
}

describe('Central chip placement', () => {
  beforeEach(() => { internals.lookup = () => undefined })
  afterEach(() => { cleanup(); resetSharedActStore() })

  it('leaves a top-level node at its own position', () => {
    expect(chipStyle([group, child, loner], 'n')).toEqual({ left: '7px', top: '9px' })
  })

  it('places a node inside a group at parent + relative position when the store has no answer yet', () => {
    expect(chipStyle([group, child, loner], 'c')).toEqual({ left: '110px', top: '220px' })
  })

  it('prefers the absolute position resolved by React Flow', () => {
    internals.lookup = (id) => (id === 'c' ? { internals: { positionAbsolute: { x: 500, y: 600 } } } : undefined)
    expect(chipStyle([group, child, loner], 'c')).toEqual({ left: '500px', top: '600px' })
  })
})

describe('absoluteNodePosition', () => {
  const byId = (...nodes: Node[]) => new Map(nodes.map((n) => [n.id, n]))

  it('sums positions through nested groups', () => {
    const inner: Node = { id: 'i', parentId: 'g', position: { x: 1, y: 2 }, data: {} }
    const leaf: Node = { id: 'l', parentId: 'i', position: { x: 3, y: 4 }, data: {} }
    expect(absoluteNodePosition(leaf, byId(group, inner, leaf))).toEqual({ x: 104, y: 206 })
  })

  it('stops at a missing parent and survives a parent cycle', () => {
    expect(absoluteNodePosition(child, byId(child))).toEqual({ x: 10, y: 20 })
    const a: Node = { id: 'a', parentId: 'b', position: { x: 1, y: 1 }, data: {} }
    const b: Node = { id: 'b', parentId: 'a', position: { x: 2, y: 2 }, data: {} }
    expect(() => absoluteNodePosition(a, byId(a, b))).not.toThrow()
  })
})
