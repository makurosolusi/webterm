/** @vitest-environment jsdom */
// A press on the tab strip that wobbles by a pixel must still be ONE click. React Flow's node drag (d3-drag, clickDistance 0)
// swallows the click that follows ANY pointer movement unless the target sits inside a `nodrag` element. Real ReactFlow.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installCanvasDom } from '../canvasHarness'
import { makeState } from './browserTabsHarness'
import { BrowserTabStrip } from './BrowserTabStrip'

const onAction = vi.fn()
const state = makeState(['a', 'b', 'c'])
const StripNode = (_: NodeProps) => <BrowserTabStrip state={state} onAction={onAction} />
const nodeTypes = { strip: StripNode }
const nodes = [{ id: 'n1', type: 'strip', position: { x: 0, y: 0 }, data: {}, style: { width: 400, height: 200 } }]

beforeAll(() => installCanvasDom())
afterEach(() => { cleanup(); onAction.mockReset() })

/** A mouse event as the browser makes it: d3-drag reads `event.view` (the window it listens on), which jsdom's constructor refuses to take. */
export function mouse(type: 'mousedown' | 'mousemove' | 'mouseup' | 'click', target: Element | Window, x: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 })
  Object.defineProperty(ev, 'view', { value: window })
  fireEvent(target, ev)
}

/** One physical click with `wobble` px of pointer travel between press and release, in the order a browser fires them. */
export function press(el: HTMLElement, wobble: number) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
  mouse('mousedown', el, 10)
  fireEvent.pointerMove(window, { clientX: 10 + wobble, clientY: 10, pointerId: 1 })
  mouse('mousemove', window, 10 + wobble)
  fireEvent.pointerUp(window, { clientX: 10 + wobble, clientY: 10, pointerId: 1 })
  mouse('mouseup', window, 10 + wobble)
  mouse('click', el, 10 + wobble)
}

describe('tab strip inside a real React Flow node', () => {
  it.each([0, 1, 3])('one press with %ipx of wobble activates the tab', async (wobble) => {
    render(<ReactFlowProvider><div style={{ width: 800, height: 600 }}><ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} /></div></ReactFlowProvider>)
    const tab = await waitFor(() => screen.getAllByRole('tab').find((t) => t.dataset.tabId === 'b') as HTMLElement)
    await waitFor(() => expect(document.querySelector('.react-flow__node')).toBeTruthy())
    press(tab, wobble)
    expect(onAction).toHaveBeenCalledWith({ type: 'activate', tabId: 'b' })
  })
})
