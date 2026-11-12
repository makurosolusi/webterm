/** @vitest-environment jsdom */
// Tab mode chrome (VS Code editor group): the tab is the node's header, its actions sit at the
// strip's right end for the active tab and in the tab's context menu, one layout switch per board.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createContext, useContext } from 'react'
import type { Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { defaultTabLayout } from '../shared/tabLayout.schema'
import NodeChrome from './NodeChrome'
import WorkspaceBar from './WorkspaceBar'
import { NodeHostContext } from './tabLayout.context'
import { releaseNodeHost } from './tabLayout.dom'
import { activateTab, connectTabLayout, useTabLayout } from './tabLayout.store'
import TabsView, { type TabsViewProps } from './tabLayout.view'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'

// NodeChrome reads its node id from React Flow; each test chrome provides its own.
const IdCtx = createContext<string | null>(null)
vi.mock('@xyflow/react', async (orig) => ({ ...(await orig<typeof import('@xyflow/react')>()), useNodeId: () => useContext(IdCtx) }))

const node = (id: string, type: string, name: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: { name } })
const NODES = [node('a', 'agentChat', 'Orchid'), node('c', 'browser', 'Cougar')]

const handlers = { onRefresh: vi.fn(), onToggleSearch: vi.fn(), onAiName: vi.fn(), onClose: vi.fn() }

/** A node as tab mode mounts it: its NodeChrome inside a host context, visible while its tab is active. */
function Chrome({ id, search = true }: { id: string; search?: boolean }) {
  const active = useTabLayout().tabs.active
  return (
    <IdCtx.Provider value={id}>
      <NodeHostContext.Provider value={{ inTab: true, visible: active === id, maximized: false }}>
        <NodeChrome
          title="t" name={id} onRename={() => {}} collapsed={false} onToggleCollapse={() => {}} color="#fff" onColor={() => {}}
          comments={[]} onAddComment={() => {}} onRefresh={handlers.onRefresh} onAiName={handlers.onAiName} onClose={handlers.onClose}
          searchOpen={false} onToggleSearch={search ? handlers.onToggleSearch : undefined}
        />
      </NodeHostContext.Provider>
    </IdCtx.Provider>
  )
}

const props = (): TabsViewProps => ({
  nodes: NODES, statuses: {}, onCloseNode: vi.fn(), onRenameNode: vi.fn(),
  onAddTerminal: vi.fn(), onAddAgent: vi.fn(), onAddDiff: vi.fn(), onAddFiles: vi.fn(),
})

function mount() {
  const p = props()
  render(<><TabsView {...p} /><Chrome id="a" /><Chrome id="c" search={false} /></>)
  act(() => activateTab('a'))
  return p
}
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) })
const editorActions = () => document.querySelector<HTMLElement>('[data-slot="tab-editor-actions"]')!

beforeEach(() => connectTabLayout({ ...defaultTabLayout(), mode: 'tabs' }, null))
afterEach(() => { cleanup(); vi.clearAllMocks(); for (const n of NODES) releaseNodeHost(n.id) })

describe('tab mode chrome', () => {
  it('renders no node header and exactly one close control per node: the tab ×', () => {
    const p = mount()
    expect(document.querySelector('.node-header')).toBeNull()
    expect(document.querySelector('[data-title="Close (ends the session)"]')).toBeNull()
    for (const name of ['Orchid', 'Cougar']) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^Close ${name}`) })).toHaveLength(1)
    }
    fireEvent.click(screen.getByRole('button', { name: /^Close Cougar/ }))
    expect(p.onCloseNode).toHaveBeenCalledWith('c')
  })

  it("puts the active tab's actions at the strip's right end, after the tabs, and follows the active tab", () => {
    mount()
    const slot = editorActions()
    expect(slot.closest('.tabs-strip__actions')).not.toBeNull()
    expect(within(slot).getByRole('button', { name: 'Search' })).toBeTruthy()
    // Focus order: the tablist comes before the editor actions.
    expect(screen.getByRole('tablist').compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(within(slot).getByRole('button', { name: 'Search' }))
    expect(handlers.onToggleSearch).toHaveBeenCalledTimes(1)
    act(() => { fireEvent.click(within(slot).getByRole('button', { name: 'More Actions…' })) })
    fireEvent.click(screen.getByRole('menuitem', { name: /Name with AI/ }))
    expect(handlers.onAiName).toHaveBeenCalledTimes(1)
    // The browser node has no search: switching tabs swaps the actions, it never shows both.
    fireEvent.click(tab('Cougar'))
    expect(within(editorActions()).queryByRole('button', { name: 'Search' })).toBeNull()
    expect(within(editorActions()).getAllByRole('button', { name: 'More Actions…' })).toHaveLength(1)
  })

  it("right-click and Shift+F10 on a tab open the node's menu items plus Close", () => {
    const p = mount()
    fireEvent.contextMenu(tab('Cougar'), { clientX: 40, clientY: 10 })
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /Refresh view/ })).toBeTruthy()
    expect(within(menu).getByText('Comments')).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Refresh view/ }))
    expect(handlers.onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(tab('Orchid'), { key: 'F10', shiftKey: true })
    const kb = screen.getByRole('menu')
    expect(within(kb).getByText('Search')).toBeTruthy()
    fireEvent.click(within(kb).getByRole('menuitem', { name: /^Close$/ }))
    expect(p.onCloseNode).toHaveBeenCalledWith('a')
  })

  it('labels a tab with the name only; title and node type are in the tooltip', () => {
    mount()
    expect(tab('Cougar').textContent).toBe('Cougar')
    expect(tab('Cougar').title).toBe('Cougar · Browser')
    expect(tab('Orchid').title).toMatch(/^Orchid · .*Agent Chat$/)
    expect(screen.getByRole('button', { name: 'New node…' })).toBeTruthy()
  })
})

describe('one layout toggle', () => {
  it('exists once in the document (workspace bar), with the editor-layout icon', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ managed: false }))))
    const ws = (id: string, name: string): Workspace =>
      ({ id, name, cwd: `/${id}`, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 }) // test-only
    render(
      <>
        <WorkspaceBar
          workspaces={[ws('w1', 'laya-api')]} activeId="w1" liveActiveNodes={[]} statuses={{}} layoutMode="tabs"
          onToggleLayout={() => {}} onSelect={() => {}} onNewWorkspace={() => {}} onRenameWorkspace={() => {}} onDeleteWorkspace={() => {}}
        />
        <TabsView {...props()} />
      </>,
    )
    const toggles = screen.getAllByRole('button', { name: 'Toggle tab layout' })
    expect(toggles).toHaveLength(1)
    expect(toggles[0].querySelector('.codicon-editor-layout')).not.toBeNull()
    expect(document.querySelector('.codicon-graph')).toBeNull()
    vi.unstubAllGlobals()
  })
})
