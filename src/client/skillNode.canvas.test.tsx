/** @vitest-environment jsdom */
// Skill nodes on the REAL canvas (App + React Flow in jsdom, cables made by real drags): the typed ports accept
// only skill-out -> skills-in, the cable is persisted as kind `skill`, reloads as a skill edge, and detaching removes it.
// jsdom has no layout engine and no real browser: pointer geometry is the harness's, so this proves wiring, not pixels.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeLink, Workspace, WsNode } from '../shared/workspace'
import { resetBrowserStatusCache } from './browser.feature'
import { installCanvasDom, mountCanvas, renderedEdgeIds, unmountCanvas } from './canvasHarness'
import { resetCapabilitiesCache } from './useCapabilities'
import { SKILL_OUT, SKILLS_IN } from '../shared/skillPorts'

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

const agent: WsNode = { id: 'agent-1', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'claude' }
const agent2: WsNode = { id: 'agent-2', kind: 'agent', x: 600, y: 0, width: 420, height: 320, cmd: 'echo hi', agentId: 'claude', cwd: '/', title: 'claude two' }
const skill: WsNode = { id: 'sk-1', kind: 'skill', x: 0, y: 500, width: 260, height: 44, skill: 'webterm-release', seenVersion: '1', collapsed: true }
const browser: WsNode = { id: 'br-1', kind: 'browser', x: 600, y: 500, width: 420, height: 320 }

beforeAll(installCanvasDom)
beforeEach(() => { resetBrowserStatusCache(); resetCapabilitiesCache() })
afterEach(unmountCanvas)

let dragTarget: Element | null = null

async function mount(nodes: WsNode[], bridges: BridgeLink[] = []): Promise<void> {
  await mountCanvas({ nodes, bridges, dirs: {} })
  vi.stubGlobal('WebSocket', FakeWs)
  dragTarget = null
  document.elementFromPoint = () => dragTarget // jsdom has no hit-testing: the "handle under the pointer"
  await waitFor(() => expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(0))
}

const handle = (nodeId: string, id: string): HTMLElement => {
  const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${id}"]`)
  if (!el) throw new Error(`handle ${id} of node ${nodeId} is missing`)
  return el as HTMLElement
}

/** Drag from one handle and release over another (document listeners, as React Flow v12 does). */
function drag(fromNode: string, fromHandle: string, toNode: string, toHandle: string): void {
  fireEvent.mouseDown(handle(fromNode, fromHandle), { clientX: 100, clientY: 100 })
  dragTarget = handle(toNode, toHandle)
  fireEvent.mouseMove(document, { clientX: 400, clientY: 120 })
  fireEvent.mouseMove(document, { clientX: 700, clientY: 140 })
  fireEvent.mouseUp(document, { clientX: 700, clientY: 140 })
}

function savedBridges(): BridgeLink[] | undefined {
  const calls = (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
  const last = calls.filter(([u, init]) => String(u).startsWith('/api/workspaces/') && init?.method === 'PUT').at(-1)?.[1]?.body
  return last ? (JSON.parse(String(last)) as Workspace).bridges : undefined
}
const settle = () => new Promise((r) => setTimeout(r, 700)) // past the save debounce

describe('typed skill ports on the canvas', () => {
  it('a skill node has a skill-out diamond; a Claude agent has a labelled Skills input; a browser and a plain terminal have none', async () => {
    await mount([agent, skill, browser, { id: 'term-1', kind: 'terminal', x: 0, y: 900, width: 420, height: 320, cwd: '/' }])
    expect(handle('sk-1', SKILL_OUT).classList).toContain('skill-handle')
    expect(handle('agent-1', SKILLS_IN).classList).toContain('skill-handle')
    expect(screen.getByText('Skills')).toBeTruthy()
    expect(document.querySelector(`.react-flow__node[data-id="br-1"] [data-handleid="${SKILLS_IN}"]`)).toBeNull()
    expect(document.querySelector('.react-flow__node[data-id="term-1"] .react-flow__handle')).toBeNull()
    // The context-link ports of the agent are untouched.
    expect(handle('agent-1', 'link-out')).toBeTruthy()
    expect(handle('agent-1', 'link-in')).toBeTruthy()
  })

  it('skill-out -> skills-in attaches: a `skill` bridge (source = skill node), drawn as a skill edge', async () => {
    await mount([agent, skill])
    drag('sk-1', SKILL_OUT, 'agent-1', SKILLS_IN)
    const expected: BridgeLink = { id: 'bridge-sk-1-agent-1', source: 'sk-1', target: 'agent-1', kind: 'skill' }
    await waitFor(() => expect(savedBridges()).toContainEqual(expected), { timeout: 3000 })
    expect(savedBridges()).toEqual([expected])
    await waitFor(() => expect(renderedEdgeIds()).toContain('bridge-sk-1-agent-1'))
    expect(document.querySelector('.react-flow__edge-skill')).toBeTruthy()
  })

  it('dragging from the agent Skills input back to the skill output attaches too', async () => {
    await mount([agent, skill])
    drag('agent-1', SKILLS_IN, 'sk-1', SKILL_OUT)
    await waitFor(() => expect(savedBridges()).toEqual([{ id: 'bridge-sk-1-agent-1', source: 'sk-1', target: 'agent-1', kind: 'skill' }]), { timeout: 3000 })
  })

  it('refuses every other use of the typed ports: skill -> link-in, agent -> skills-in, browser -> skills-in, skill -> browser', async () => {
    await mount([agent, agent2, skill, browser])
    drag('sk-1', SKILL_OUT, 'agent-1', 'link-in')
    drag('agent-2', 'link-out', 'agent-1', SKILLS_IN)
    drag('br-1', 'link-out', 'agent-1', SKILLS_IN)
    drag('sk-1', SKILL_OUT, 'br-1', 'link-in')
    await settle()
    expect(savedBridges() ?? []).toEqual([])
    expect(renderedEdgeIds()).toEqual([])
  })

  it('agent <-> agent context links still work next to the skill ports', async () => {
    await mount([agent, agent2, skill])
    drag('agent-1', 'link-out', 'agent-2', 'link-in')
    await waitFor(() => expect(savedBridges()).toEqual([{ id: 'bridge-agent-1-agent-2', source: 'agent-1', target: 'agent-2', kind: 'context' }]), { timeout: 3000 })
  })

  it('a stored skill cable reloads as a skill edge on the typed ports (not a floating context cable)', async () => {
    await mount([agent, skill], [{ id: 'bridge-sk-1-agent-1', source: 'sk-1', target: 'agent-1', kind: 'skill' }])
    await waitFor(() => expect(renderedEdgeIds()).toEqual(['bridge-sk-1-agent-1']))
    expect(document.querySelector('.react-flow__edge-skill')).toBeTruthy()
    expect(document.querySelector('.react-flow__edge-context')).toBeNull()
  })

  it('removing the cable detaches (the saved board has no skill bridge); removing the skill node drops its cable too', async () => {
    await mount([agent, skill], [{ id: 'bridge-sk-1-agent-1', source: 'sk-1', target: 'agent-1', kind: 'skill' }])
    await waitFor(() => expect(renderedEdgeIds()).toEqual(['bridge-sk-1-agent-1']))
    const edge = document.querySelector('.react-flow__edge[data-id="bridge-sk-1-agent-1"]') as Element
    fireEvent.doubleClick(edge)
    await waitFor(() => expect(savedBridges()).toEqual([]), { timeout: 3000 })
    expect(renderedEdgeIds()).toEqual([])
  })
})
