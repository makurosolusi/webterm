/** @vitest-environment jsdom */
// Tab mode is view-only: NodeChrome hides every control that would rewrite the node's canvas layout.
import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import NodeChrome from './NodeChrome'
import { NodeHostContext } from './tabLayout.context'
import { findNodeRoot, nodeIdOf } from './nodeRoot'

// NodeChrome reads its node id from React Flow; outside a flow there is none, so give it one.
vi.mock('@xyflow/react', async (orig) => ({ ...(await orig<typeof import('@xyflow/react')>()), useNodeId: () => 'n1' }))

const props = {
  title: 'api', onRename: () => {}, collapsed: false, onToggleCollapse: vi.fn(),
  color: '#fff', onColor: () => {}, comments: [], onAddComment: () => {},
  onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {},
  onClose: () => {},
}
const titles = (c: HTMLElement) => [...c.querySelectorAll('vscode-toolbar-button')].map((b) => b.getAttribute('data-title'))
const inTab = (ui: ReactNode) => <NodeHostContext.Provider value={{ inTab: true, visible: true, maximized: false }}>{ui}</NodeHostContext.Provider>

afterEach(cleanup)

describe('NodeChrome gating', () => {
  it('canvas (default context): header with collapse, resize toggle, maximize and close', () => {
    const { container } = render(<NodeChrome {...props} />)
    expect(container.querySelector('.node-header')).not.toBeNull()
    expect(titles(container)).toContain('Close (ends the session)')
    expect(titles(container)).toEqual(expect.arrayContaining(['Collapse', 'Maximize']))
    expect(titles(container)).not.toContain('Full Screen')
    expect(container.querySelector('.node-resize-toggle')).not.toBeNull()
  })

  it('tab: no node header at all (the tab is the header), so no collapse, maximize, search or close here', () => {
    const { container } = render(inTab(<NodeChrome {...props} />))
    expect(container.querySelector('.node-header')).toBeNull()
    expect(titles(container)).toEqual([])
    expect(container.querySelector('.node-resize-toggle')).toBeNull()
  })

  it('tab: a collapsed node shows no Expand button either', () => {
    const { container } = render(inTab(<NodeChrome {...props} collapsed />))
    expect(titles(container)).not.toContain('Expand')
  })
})

describe('node root lookup', () => {
  it('finds the id from a pane or a canvas wrapper, and prefers the pane', () => {
    document.body.innerHTML = '<div class="react-flow__node" data-id="a"></div><div data-tab-node="" data-id="a"><i id="in"></i></div><div class="react-flow__node" data-id="b"><i id="in2"></i></div>'
    expect(nodeIdOf(document.getElementById('in'))).toBe('a')
    expect(nodeIdOf(document.getElementById('in2'))).toBe('b')
    expect(findNodeRoot('a')?.hasAttribute('data-tab-node')).toBe(true)
    expect(findNodeRoot('b')?.className).toBe('react-flow__node')
    expect(findNodeRoot('zzz')).toBeUndefined()
    document.body.innerHTML = ''
  })
})

describe('node-chrome.css in tab mode', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/client/node-chrome.css'), 'utf8')

  it('lights the status glow on the pane, animated and static (reduced motion)', () => {
    expect(css).toContain('[data-tab-node]:has(.term-node.working)::after')
    expect(css).toContain('[data-tab-node]:has(.term-node.attention)::after')
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(rm).toContain('[data-tab-node]:has(.term-node.working)::after')
    expect(rm).toContain('[data-tab-node]:has(.term-node.attention)::after')
  })

  it('draws the pane glow INSIDE the pane so its overflow clip cannot cut it', () => {
    const block = css.slice(css.indexOf('[data-tab-node]:has(.term-node.working)::after {'))
    expect(block.slice(0, block.indexOf('}'))).toContain('inset 0 0')
  })

  it('applies the canvas-only collapse rules to .react-flow__node, not to a tab pane', () => {
    expect(css).toContain('.react-flow__node .term-node--collapsed .node-body { display: none; }')
    expect(css).not.toMatch(/^\.term-node--collapsed/m)
  })

  it('has no OS full screen rule and no new !important', () => {
    expect(css).not.toContain(':fullscreen')
    expect((css.match(/!important/g) ?? []).length).toBe(1)
  })
})
