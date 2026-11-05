/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import type { NodeProps } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import BoardHost from './BoardHost'
import { connectTabLayout, setMode } from './tabLayout.store'
import { getNodeHost } from './tabLayout.dom'

const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
g.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./App.canvas', async () => {
  const { withTabPortal } = await import('./tabLayout.portal')
  const Wrapped = withTabPortal(() => <x-frame />)
  return { default: () => <Wrapped {...({ id: 'n1', type: 'terminal', data: {} } as unknown as NodeProps)} /> }
})

declare module 'react' { namespace JSX { interface IntrinsicElements { 'x-frame': object } } }

// Stand-in for an iframe: a disconnect outside our moveBefore stub means the host left the document.
let inMove = false
const t = { strayDisconnects: 0, moves: [] as boolean[], appends: 0 }
class XFrame extends HTMLElement { disconnectedCallback() { if (!inMove) t.strayDisconnects++ } }

const tabs = {
  nodes: [{ id: 'n1', type: 'terminal', position: { x: 0, y: 0 }, data: {} }], statuses: {}, onCloseNode: vi.fn(), onRenameNode: vi.fn(),
  onAddTerminal: vi.fn(), onAddAgent: vi.fn(), onAddDiff: vi.fn(), onAddFiles: vi.fn(),
}
const proto = Element.prototype as unknown as { moveBefore?: unknown }
const origAppend = Node.prototype.appendChild

beforeEach(() => {
  if (!customElements.get('x-frame')) customElements.define('x-frame', XFrame)
  Object.assign(t, { strayDisconnects: 0, moves: [], appends: 0 })
  proto.moveBefore = function (this: Element, node: Node, ref: Node | null) {
    t.moves.push(node.isConnected)
    inMove = true
    try { this.insertBefore(node, ref) } finally { inMove = false }
  }
  Node.prototype.appendChild = function <T extends Node>(this: Node, n: T): T {
    if ((n as Node) === getNodeHost('n1')) t.appends++
    return origAppend.call(this, n) as T
  }
  connectTabLayout({ ...defaultTabLayout(), tabs: { ...defaultTabLayout().tabs, order: ['n1'], active: 'n1' } }, null)
})
afterEach(() => { cleanup(); delete proto.moveBefore; Node.prototype.appendChild = origAppend; connectTabLayout(undefined, null) })

describe('host never leaves the document across mode switches', () => {
  it('canvas -> tabs -> canvas uses connected moveBefore only, iframe never detached', () => {
    render(<BoardHost canvas={{} as never} tabs={tabs} />)
    const host = getNodeHost('n1')
    expect(host.isConnected).toBe(true)
    expect(t.appends).toBe(1) // first placement only
    for (let i = 0; i < 3; i++) {
      act(() => setMode('tabs'))
      expect(host.isConnected).toBe(true)
      expect(host.parentElement?.hasAttribute('data-tab-node')).toBe(true)
      act(() => setMode('canvas'))
      expect(host.isConnected).toBe(true)
      expect(host.parentElement?.className).toBe('tab-host-slot')
    }
    // per round: canvas->pane, pane->parking, parking->slot
    expect(t.moves).toHaveLength(9)
    expect(t.moves.every(Boolean)).toBe(true)
    expect(t.appends).toBe(1)
    expect(t.strayDisconnects).toBe(0)
  })
})
