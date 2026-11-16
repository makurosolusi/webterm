/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActMsg } from '../shared/protocol'
import { resetSharedActStore } from './centralAct.store'
import CentralActMount, { CABLE_ACTIVE_CLASS, markTouched, TOUCHED_CLASS } from './centralAct.layer'
import { dispatchBroadcast } from './ws.listeners'
import type { ActEntry } from './centralAct.store'

afterEach(() => { cleanup(); resetSharedActStore() })

const frame = (nodeId: string, over: Partial<ActMsg> = {}): ActMsg => ({ t: 'act', v: 1, tool: 'canvas.type', verb: 'typed', nodeId, n: 1, ...over })
const far: Node = { id: 'far', position: { x: 90_000, y: 90_000 }, data: { title: 'Far away' } }

/** A tiny stand-in for the React Flow instance: every camera/selection method is a spy. */
function fakeRf() {
  const rf = {
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })), fitView: vi.fn(), setCenter: vi.fn(), setViewport: vi.fn(), zoomTo: vi.fn(),
    setNodes: vi.fn(), getNode: vi.fn((id: string) => (id === 'far' ? far : undefined)),
  }
  return { rf, ref: { current: rf as unknown as ReactFlowInstance } }
}

describe('Central act signal vs camera and selection', () => {
  beforeEach(() => { try { localStorage.clear() } catch { /* jsdom always has it */ } })

  it('Follow OFF: an act frame marks and announces but moves nothing and selects nothing; only Show does', () => {
    localStorage.setItem('webterm.centralFollow', 'off')
    const { rf, ref } = fakeRf()
    render(<ReactFlowProvider><CentralActMount rf={ref} nodes={[far]} workspaceId="w1" /></ReactFlowProvider>)
    const before = document.activeElement
    act(() => { dispatchBroadcast(frame('far')) })
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('Central typed Far away')
    for (const fn of [rf.fitView, rf.setCenter, rf.setViewport, rf.zoomTo, rf.setNodes]) expect(fn).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(rf.fitView).toHaveBeenCalledTimes(1) // revealNode: the node was off screen
    expect(rf.fitView.mock.calls[0]?.[0]).toMatchObject({ nodes: [{ id: 'far' }] })
    expect(rf.setNodes).toHaveBeenCalledTimes(1) // selectOnly (user click only)
    expect(rf.setCenter).not.toHaveBeenCalled()
  })

  it('Follow ON (default): the frame moves the camera once via fitView, with no selection change and no focus steal', () => {
    const { rf, ref } = fakeRf()
    render(<ReactFlowProvider><CentralActMount rf={ref} nodes={[far]} workspaceId="w1" /></ReactFlowProvider>)
    const before = document.activeElement
    act(() => { dispatchBroadcast(frame('far')) })
    expect(rf.fitView).toHaveBeenCalledTimes(1)
    expect(rf.fitView.mock.calls[0]?.[0]).toMatchObject({ nodes: [{ id: 'far' }] })
    for (const fn of [rf.setCenter, rf.setViewport, rf.zoomTo, rf.setNodes]) expect(fn).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(before)
  })

  it('a user gesture on the canvas (pointer, wheel, Esc) pauses Follow: the frame moves nothing', () => {
    for (const gesture of [
      (el: Element) => fireEvent.pointerDown(el), (el: Element) => fireEvent.wheel(el), () => fireEvent.keyDown(document.body, { key: 'Escape' }),
    ]) {
      const { rf, ref } = fakeRf()
      const { unmount } = render(<div className="react-flow"><div id="pane" /><ReactFlowProvider><CentralActMount rf={ref} nodes={[far]} workspaceId="w1" /></ReactFlowProvider></div>)
      act(() => { gesture(document.getElementById('pane')!) })
      act(() => { dispatchBroadcast(frame('far')) })
      expect(rf.fitView).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /Paused/ })).toBeTruthy()
      unmount(); cleanup(); resetSharedActStore()
    }
  })

  it('the Follow switch turns it off and back on', () => {
    const { rf, ref } = fakeRf()
    render(<ReactFlowProvider><CentralActMount rf={ref} nodes={[far]} workspaceId="w1" /></ReactFlowProvider>)
    act(() => { dispatchBroadcast(frame('far')) })
    fireEvent.click(screen.getByRole('button', { name: /Following Central/ }))
    expect(localStorage.getItem('webterm.centralFollow')).toBe('off')
    expect(screen.getByRole('button', { name: 'Follow off' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Follow off' }))
    expect(localStorage.getItem('webterm.centralFollow')).toBe('on')
    expect(rf.setCenter).not.toHaveBeenCalled()
  })
})

describe('markTouched', () => {
  const e = (nodeId: string, verb: string, nodeId2?: string): ActEntry => ({ nodeId, verb, tool: 't', n: 1, ts: 0, seq: 1, ...(nodeId2 ? { nodeId2 } : {}) })
  const nodes: Node[] = [{ id: 'a', position: { x: 0, y: 0 }, data: {} }, { id: 'b', position: { x: 0, y: 0 }, data: {} }]
  const edges: Edge[] = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }]

  it('returns the very same arrays when nothing is touched', () => {
    const out = markTouched(nodes, edges, [])
    expect(out.nodes).toBe(nodes)
    expect(out.edges).toBe(edges)
  })

  it('classes the touched node only and keeps the others by identity', () => {
    const out = markTouched(nodes, edges, [e('a', 'typed')])
    expect(out.nodes[0]?.className).toBe(TOUCHED_CLASS)
    expect(out.nodes[1]).toBe(nodes[1])
    expect(out.edges).toBe(edges) // typing is not a cable verb
  })

  it('drove / wired light the cables of the node (and of its partner)', () => {
    expect(markTouched(nodes, edges, [e('a', 'drove')]).edges.map((x) => x.className)).toEqual([CABLE_ACTIVE_CLASS, undefined])
    expect(markTouched(nodes, edges, [e('a', 'wired', 'b')]).edges.map((x) => x.className)).toEqual([CABLE_ACTIVE_CLASS, CABLE_ACTIVE_CLASS])
  })
})
