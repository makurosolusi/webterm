/** @vitest-environment jsdom */
// Global nodeClickDistance: a wobble up to NODE_CLICK_DISTANCE is still a click on a plain (not `nodrag`) node control;
// a real drag still moves the node and swallows the click. Real ReactFlow, like BrowserTabStrip.click.test.tsx.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import type { NodeChange, NodeProps } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom } from './canvasHarness'
import { NODE_CLICK_DISTANCE } from './canvas.clickDistance'
import { press } from './canvas.pointer.testkit'

const onClick = vi.fn()
const onNodesChange = vi.fn<(c: NodeChange[]) => void>()
const PlainNode = (_: NodeProps) => <button type="button" onClick={onClick}>plain</button>
const nodeTypes = { plain: PlainNode }
const nodes = [{ id: 'n1', type: 'plain', position: { x: 0, y: 0 }, data: {}, style: { width: 400, height: 200 } }]

beforeAll(() => installCanvasDom())
afterEach(() => { cleanup(); onClick.mockReset(); onNodesChange.mockReset() })

async function mount(clickDistance: number | undefined) {
  render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow defaultNodes={nodes} edges={[]} nodeTypes={nodeTypes} nodeClickDistance={clickDistance} onNodesChange={onNodesChange} />
      </div>
    </ReactFlowProvider>,
  )
  await waitFor(() => expect(document.querySelector('.react-flow__node')).toBeTruthy())
  return screen.getByRole('button', { name: 'plain' })
}
const moved = () => onNodesChange.mock.calls.some(([c]) => c.some((x) => x.type === 'position' && x.dragging))

describe('nodeClickDistance', () => {
  it('is a small positive number', () => {
    expect(NODE_CLICK_DISTANCE).toBeGreaterThan(0)
    expect(NODE_CLICK_DISTANCE).toBeLessThan(6)
  })
  it('control: with the React Flow default (0) a 2px wobble swallows the click', async () => {
    press(await mount(undefined), 2)
    expect(onClick).not.toHaveBeenCalled()
  })
  it.each([0, 1, NODE_CLICK_DISTANCE])('with the global distance a %ipx wobble is still a click', async (wobble) => {
    press(await mount(NODE_CLICK_DISTANCE), wobble)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it('a real drag still moves the node and swallows the click', async () => {
    press(await mount(NODE_CLICK_DISTANCE), 40, 8)
    expect(moved()).toBe(true)
    expect(onClick).not.toHaveBeenCalled()
  })
})
