/** @vitest-environment jsdom */
// Palette drops and the Delete key on the REAL canvas (App + React Flow in jsdom). jsdom has no layout, so the pane rect is
// zero and flow = screen - viewport offset; this proves the wiring (handler -> board -> node/cable), not real drag pixels.
import { createEvent, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeLink, Workspace, WsNode } from '../shared/workspace'
import { installCanvasDom, mountCanvas, renderedEdgeIds, unmountCanvas } from './canvasHarness'
import { SKILL_DRAG_MIME } from './skillPalette.drag'

class FakeWs {
  binaryType = ''
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send() {}
  close() { this.readyState = 3 }
}

const VIEWPORT = { x: 0, y: 0, zoom: 1 }
// test-only fixtures
const agent: WsNode = { id: 'agent-1', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'Ada' }
const skill: WsNode = { id: 'sk-1', kind: 'skill', x: 0, y: 500, width: 260, height: 44, skill: 'webterm-release', seenVersion: '1', collapsed: true }
const CABLE: BridgeLink = { id: 'bridge-sk-1-agent-1', source: 'sk-1', target: 'agent-1', kind: 'skill' }
const PAYLOAD = JSON.stringify({ name: 'webterm-deploy', version: '2' })

beforeAll(installCanvasDom)
beforeEach(() => { vi.stubGlobal('WebSocket', FakeWs) })
afterEach(unmountCanvas)

const pane = () => document.querySelector('.react-flow__pane') as HTMLElement
const skillNodes = () => document.querySelectorAll('.react-flow__node-skill')
const settle = () => new Promise((r) => setTimeout(r, 700)) // past the save debounce

function savedBridges(): BridgeLink[] | undefined {
  const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
  const last = calls.filter(([u, init]) => String(u).startsWith('/api/workspaces/') && init?.method === 'PUT').at(-1)?.[1]?.body
  return last ? (JSON.parse(String(last)) as Workspace).bridges : undefined
}

/** A drag event of the palette's private MIME at screen point (x, y). */
function skillDrag(type: 'dragOver' | 'drop', target: Element, x: number, y: number) {
  const dt = { types: [SKILL_DRAG_MIME], getData: (t: string) => (t === SKILL_DRAG_MIME ? PAYLOAD : ''), files: [], dropEffect: '' }
  const ev = Object.assign(createEvent[type](target, { dataTransfer: dt }), { clientX: x, clientY: y })
  fireEvent(target, ev)
  return ev
}

describe('dropping a palette skill', () => {
  it('on the pane: a skill node appears, uncabled', async () => {
    await mountCanvas({ nodes: [agent], dirs: {}, viewport: VIEWPORT })
    expect(skillDrag('dragOver', pane(), 900, 600).defaultPrevented).toBe(true)
    expect(skillDrag('drop', pane(), 900, 600).defaultPrevented).toBe(true)
    await waitFor(() => expect(skillNodes()).toHaveLength(1))
    expect(renderedEdgeIds()).toEqual([])
  })

  it('on an agent node (the drag is accepted over a node too): a skill node appears and is cabled to it', async () => {
    await mountCanvas({ nodes: [agent], dirs: {}, viewport: VIEWPORT })
    const node = document.querySelector('.react-flow__node-agent') as HTMLElement
    expect(skillDrag('dragOver', node, 100, 100).defaultPrevented).toBe(true)
    skillDrag('drop', node, 100, 100)
    await waitFor(() => expect(skillNodes()).toHaveLength(1))
    await waitFor(() => expect(renderedEdgeIds()).toHaveLength(1))
  })
})

describe('Delete key', () => {
  const selectCable = async () => {
    await mountCanvas({ nodes: [agent, skill], bridges: [CABLE], dirs: {} })
    await waitFor(() => expect(renderedEdgeIds()).toEqual([CABLE.id]))
    fireEvent.click(document.querySelector(`.react-flow__edge[data-id="${CABLE.id}"]`) as Element)
    await waitFor(() => expect(document.querySelector('.react-flow__edge.selected')).toBeTruthy())
  }

  it('Delete (not only Backspace) detaches the selected skill cable and saves it', async () => {
    await selectCable()
    fireEvent.keyDown(document, { key: 'Delete', code: 'Delete' })
    await waitFor(() => expect(renderedEdgeIds()).toEqual([]))
    await settle()
    expect(savedBridges()).toEqual([])
  })

  it('Delete typed in an input is the input\'s: the cable stays', async () => {
    await selectCable()
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    fireEvent.keyDown(input, { key: 'Delete', code: 'Delete' })
    await new Promise((r) => setTimeout(r, 50))
    expect(renderedEdgeIds()).toEqual([CABLE.id])
    input.remove()
  })
})
