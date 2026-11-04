/**
 * @vitest-environment jsdom
 */
// F3-d on the REAL canvas: closing a cabled node and pressing Undo brings back the node AND its
// cable. React Flow removes the edges before the node, so this is the path that proves the stash in
// `App.board` + `useCanvasUndo` + `restoreBridges` are wired (a hook test cannot see that order).
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, renderedEdgeIds, unmountCanvas } from './canvasHarness'
import type { BridgeLink, WsNode } from '../shared/workspace'

vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: () => undefined }
})

vi.setConfig({ testTimeout: 60_000 })

// Agents, not plain terminals: only agent nodes carry link handles, so only their cables render.
const a: WsNode = { id: 'term-a', kind: 'agent', x: 0, y: 0, width: 420, height: 320, cmd: 'echo a', agentId: 'claude', cwd: '/', title: 'a' }
const b: WsNode = { id: 'term-b', kind: 'agent', x: 600, y: 0, width: 420, height: 320, cmd: 'echo b', agentId: 'claude', cwd: '/', title: 'b' }
const cable: BridgeLink = { id: 'bridge-term-a-term-b', source: 'term-a', target: 'term-b', kind: 'context' }

beforeAll(installCanvasDom)
afterEach(unmountCanvas)

const closeBtn = (nodeId: string): HTMLElement => {
  const node = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
  const el = node?.querySelector('button[title="Close (ends the session)"], vscode-toolbar-button[data-title="Close (ends the session)"]')
  if (!el) throw new Error(`no close button on ${nodeId}`)
  return el as HTMLElement
}
const undoBtn = (): HTMLElement => {
  const el = document.querySelector('[aria-label="Undo"]')
  if (!el) throw new Error('no Undo in the status bar')
  return el as HTMLElement
}
const nodeIds = () => Array.from(document.querySelectorAll('.react-flow__node')).map((n) => n.getAttribute('data-id'))

describe('undo close node (canvas)', () => {
  it('Undo after closing a cabled node restores the node and its cable', async () => {
    await mountCanvas({ nodes: [a, b], bridges: [cable], dirs: {} })
    document.elementFromPoint = () => null // jsdom has no hit-test
    await waitFor(() => expect(renderedEdgeIds()).toEqual([cable.id]))

    fireEvent.click(closeBtn('term-a'))
    await waitFor(() => expect(nodeIds()).toEqual(['term-b']))
    expect(renderedEdgeIds()).toEqual([])

    fireEvent.click(undoBtn())
    await waitFor(() => expect(nodeIds().sort()).toEqual(['term-a', 'term-b']))
    await waitFor(() => expect(renderedEdgeIds()).toEqual([cable.id]))
  })
})
