/**
 * @vitest-environment jsdom
 */
// Closing a node asks first, on the REAL canvas: the × button and the Delete key both reach React
// Flow `deleteElements` → `onBeforeDelete` (nodeCloseConfirm.tsx). Cancel must leave node, session
// and cables intact; Close must remove exactly as before. Edge deletes and system removals (redo)
// must never prompt.
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, renderedEdgeIds, unmountCanvas } from './canvasHarness'
import { nodeCloseCopy } from './nodeCloseConfirm'
import type { BridgeLink, WsNode } from '../shared/workspace'

const { sent } = vi.hoisted(() => ({ sent: [] as { t: string; id: string }[] }))
vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: (m: { t: string; id: string }) => { sent.push(m) } }
})

// test-only fixtures. Agents carry link handles, so their cable renders.
const term: WsNode = { id: 'term-1', kind: 'terminal', x: 0, y: 0, width: 420, height: 320, cwd: '/', title: 'shell' }
const a: WsNode = { id: 'ag-a', kind: 'agent', x: 0, y: 400, width: 420, height: 320, cmd: 'echo a', agentId: 'claude', cwd: '/', title: 'a' }
const b: WsNode = { id: 'ag-b', kind: 'agent', x: 600, y: 400, width: 420, height: 320, cmd: 'echo b', agentId: 'claude', cwd: '/', title: 'b' }
const cable: BridgeLink = { id: 'bridge-ag-a-ag-b', source: 'ag-a', target: 'ag-b', kind: 'context' }

beforeAll(installCanvasDom)
beforeEach(() => { sent.length = 0 })
afterEach(unmountCanvas)

const nodeEl = (id: string): HTMLElement => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  if (!el) throw new Error(`node ${id} not rendered`)
  return el as HTMLElement
}
const closeBtn = (id: string): HTMLElement => {
  const el = nodeEl(id).querySelector('button[title="Close (ends the session)"], vscode-toolbar-button[data-title="Close (ends the session)"]')
  if (!el) throw new Error(`no close button on ${id}`)
  return el as HTMLElement
}
const nodeIds = () => Array.from(document.querySelectorAll('.react-flow__node')).map((n) => n.getAttribute('data-id')).sort()
const dialog = () => document.querySelector('[data-slot="vscode-dialog"]')
const closed = (id: string) => sent.some((m) => m.t === 'close' && m.id === id)
/** Let React Flow's async `deleteElements` (awaits `onBeforeDelete`) run its microtasks. */
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 20)))

describe('node close confirm (canvas)', () => {
  it('× opens the dialog without removing; Cancel keeps node, session and cable', async () => {
    await mountCanvas({ nodes: [term, a, b], bridges: [cable], dirs: {} })
    document.elementFromPoint = () => null // jsdom has no hit-test
    await waitFor(() => expect(renderedEdgeIds()).toEqual([cable.id]))

    fireEvent.click(closeBtn('term-1'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(screen.getByText('Close “shell”?')).toBeTruthy()
    expect(screen.getByText('Its terminal session and any process running in it will end.')).toBeTruthy()
    // nodeterm's keyboard rule: focus starts on Cancel, never on the destructive button.
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(nodeIds()).toContain('term-1')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await flush()
    expect(dialog()).toBeNull()
    expect(nodeIds()).toEqual(['ag-a', 'ag-b', 'term-1'])
    expect(closed('term-1')).toBe(false)

    // Cancelling an agent close keeps its cable too (edges ride in the same delete).
    fireEvent.click(closeBtn('ag-a'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.keyDown(document, { key: 'Escape' })
    await flush()
    expect(dialog()).toBeNull()
    expect(renderedEdgeIds()).toEqual([cable.id])
    expect(closed('ag-a')).toBe(false)
  })

  it('Close removes the node and ends its session', async () => {
    await mountCanvas({ nodes: [term], dirs: {} })
    document.elementFromPoint = () => null
    fireEvent.click(closeBtn('term-1'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(dialog()).toBeNull()
    expect(closed('term-1')).toBe(true)
  })

  it('the Delete key path prompts too, with one dialog for a multi-selection', async () => {
    await mountCanvas({ nodes: [term, a], dirs: {} })
    document.elementFromPoint = () => null
    // Multi-select: hold React Flow's multi-selection key (Control off macOS) while clicking.
    fireEvent.keyDown(document, { key: 'Control' })
    fireEvent.click(nodeEl('term-1'))
    fireEvent.click(nodeEl('ag-a'))
    fireEvent.keyUp(document, { key: 'Control' })
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node.selected').length).toBe(2))

    fireEvent.keyDown(document, { key: 'Backspace' })
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(screen.getByText('Close 2 nodes?')).toBeTruthy()
    expect(screen.getByText('Terminal sessions and their running processes will end. Agent sessions will end, interrupting anything they are running.')).toBeTruthy()
    expect(nodeIds()).toEqual(['ag-a', 'term-1'])

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(closed('term-1') && closed('ag-a')).toBe(true)
  })

  it('an edge double-click deletes the cable without prompting', async () => {
    await mountCanvas({ nodes: [a, b], bridges: [cable], dirs: {} })
    await waitFor(() => expect(renderedEdgeIds()).toEqual([cable.id]))
    fireEvent.doubleClick(document.querySelector(`.react-flow__edge[data-id="${cable.id}"]`)!)
    await waitFor(() => expect(renderedEdgeIds()).toEqual([]))
    expect(dialog()).toBeNull()
    expect(nodeIds()).toEqual(['ag-a', 'ag-b'])
  })

  it('a system removal (redo of a close) does not prompt', async () => {
    await mountCanvas({ nodes: [term, a], dirs: {} })
    document.elementFromPoint = () => null
    fireEvent.click(closeBtn('term-1'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(nodeIds()).toEqual(['ag-a']))

    fireEvent.click(document.querySelector('[aria-label="Undo"]')!)
    await waitFor(() => expect(nodeIds()).toEqual(['ag-a', 'term-1']))
    fireEvent.click(document.querySelector('[aria-label="Redo"]')!)
    await waitFor(() => expect(nodeIds()).toEqual(['ag-a']))
    await flush()
    expect(dialog()).toBeNull()
  })
})

describe('nodeCloseCopy', () => {
  it('names what ends per node kind, and falls back for kinds with nothing running', () => {
    expect(nodeCloseCopy([{ id: 'd', type: 'diff', data: {} }])).toEqual({ title: 'Close “this node”?', body: 'It will be removed from the canvas.' })
    expect(nodeCloseCopy([{ id: 'c', type: 'agentChat', data: {} }]).title).toBe('Close “Agent chat”?')
    expect(nodeCloseCopy([{ id: 't1', type: 'terminal', data: {} }, { id: 't2', type: 'terminal', data: {} }, { id: 'f', type: 'files', data: {} }])).toEqual({
      title: 'Close 3 nodes?', body: 'Terminal sessions and their running processes will end.',
    })
  })
})
