/** @vitest-environment jsdom */
// Tab mode is view-only: NodeChrome hides every control that would rewrite the node's canvas layout.
import { act, cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import NodeChrome from './NodeChrome'
import { NodeHostContext } from './tabLayout.context'
import { findNodeRoot, nodeIdOf } from './nodeRoot'

const props = {
  title: 'api', onRename: () => {}, collapsed: false, onToggleCollapse: vi.fn(),
  color: '#fff', onColor: () => {}, comments: [], onAddComment: () => {},
  onRefresh: () => {}, searchOpen: false, onToggleSearch: () => {},
  maximized: false, onToggleMaximize: vi.fn(), onClose: () => {},
}
const titles = (c: HTMLElement) => [...c.querySelectorAll('vscode-toolbar-button')].map((b) => b.getAttribute('data-title'))
const inTab = (ui: ReactNode) => <NodeHostContext.Provider value={{ inTab: true, visible: true }}>{ui}</NodeHostContext.Provider>

afterEach(cleanup)

describe('NodeChrome gating', () => {
  it('canvas (default context): collapse, resize toggle and maximize are all there', () => {
    const { container } = render(<NodeChrome {...props} />)
    expect(titles(container)).toEqual(expect.arrayContaining(['Collapse', 'Maximize', 'Full Screen']))
    expect(container.querySelector('.node-resize-toggle')).not.toBeNull()
  })

  it('tab: no collapse, resize toggle or maximize; search/full screen/close remain', () => {
    const { container } = render(inTab(<NodeChrome {...props} />))
    const t = titles(container)
    expect(t).not.toContain('Collapse')
    expect(t).not.toContain('Expand')
    expect(t).not.toContain('Maximize')
    expect(container.querySelector('.node-resize-toggle')).toBeNull()
    expect(t).toEqual(expect.arrayContaining(['Search', 'Full Screen', 'Close (ends the session)']))
  })

  it('tab: a collapsed node shows no Expand button either', () => {
    const { container } = render(inTab(<NodeChrome {...props} collapsed />))
    expect(titles(container)).not.toContain('Expand')
  })
})

describe('Full Screen in a tab pane', () => {
  const request = vi.fn()
  beforeEach(() => {
    request.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(Element.prototype, 'requestFullscreen', { value: request, configurable: true, writable: true })
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true })
  })

  it('fullscreens the pane that holds the node', async () => {
    const { container } = render(inTab(<div data-tab-node="" data-id="n1"><NodeChrome {...props} /></div>))
    await act(async () => { (container.querySelector('[data-title="Full Screen"]') as HTMLElement).click() })
    expect(request.mock.contexts[0]).toBe(container.firstChild)
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

  it('has a fullscreen rule for the pane and no new !important', () => {
    expect(css).toContain('[data-tab-node]:fullscreen { background: var(--panel); }')
    expect((css.match(/!important/g) ?? []).length).toBe(1)
  })
})
