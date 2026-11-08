/** @vitest-environment jsdom */
// Node tab strip above the canvas: tabs per node (icon, title, agent status), click selects and
// reveals, × / middle-click close, drag reorder persists, overflow pick, and the Show Node Tabs toggle.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import { connectTabLayout, getTabLayout } from './tabLayout.store'
import NodeTabs, { nodeTabItems, type NodeTabsProps } from './tabLayout.canvasStrip'
import { nextTabIndex } from './tabLayout.strip'
import { hiddenTabIds } from './tabLayout.overflow'
import { nodeTabSignal, sessionSignal, UNREAD_LABEL } from './sessionSignal'
import { clearUnread, markUnread } from './unread'
import { nodeTabsShown, reloadNodeTabsShown, setNodeTabsShown, toggleNodeTabs, useNodeTabsShown } from './nodeTabs.visible'

const node = (id: string, type: string, title?: string, extra: Partial<Node> = {}): Node =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title }, ...extra })
// test-only fixture: one node of every kind the strip has to tell apart.
const NODES = [
  node('ag', 'agent', 'claude'), node('ch', 'agentChat', 'chat'), node('br', 'browser'),
  node('ed', 'editor', undefined, { data: { filePath: '/repo/api.ts' } }), node('fi', 'files', 'repo'), node('te', 'terminal', 'shell'),
]

function fakeRf(nodes: Node[]) {
  return {
    getNode: (id: string) => nodes.find((n) => n.id === id),
    setNodes: vi.fn(),
    // Viewport far away: every node is out of view, so a reveal has to move the camera.
    getViewport: () => ({ x: -100_000, y: -100_000, zoom: 1 }),
    fitView: vi.fn(() => Promise.resolve(true)),
  }
}

let rf: ReturnType<typeof fakeRf>
const props = (over: Partial<NodeTabsProps> = {}): NodeTabsProps => ({
  nodes: NODES, statuses: {}, rf: { current: rf as unknown as ReactFlowInstance }, onCloseNode: vi.fn(), onRenameNode: vi.fn(), ...over,
})
const tab = (title: string) => screen.getByText(title).closest<HTMLElement>('[role="tab"]')!
const titles = () => screen.getAllByRole('tab').map((t) => t.querySelector('.tabs-tab__title')?.textContent)

beforeEach(() => { rf = fakeRf(NODES); connectTabLayout(defaultTabLayout(), null) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('NodeTabs', () => {
  it('one tab per node in creation order, each with its kind icon and title', () => {
    render(<NodeTabs {...props()} />)
    expect(screen.getByRole('tablist', { name: 'Nodes' })).toBeTruthy()
    expect(titles()).toEqual(['claude', 'chat', 'Browser', 'api.ts', 'repo', 'shell'])
    const icon = (title: string) => tab(title).querySelector('.tabs-tab__icon')?.className
    expect(icon('claude')).toContain('codicon-hubot')
    expect(icon('chat')).toContain('codicon-comment-discussion')
    expect(icon('Browser')).toContain('codicon-globe')
    expect(icon('api.ts')).toContain('codicon-file')
    expect(icon('repo')).toContain('codicon-folder')
    expect(icon('shell')).toContain('codicon-terminal')
    // Order lands in the workspace layout (persisted with the workspace), Files included.
    expect(getTabLayout().tabs.order).toEqual(['ag', 'ch', 'br', 'ed', 'fi', 'te'])
  })

  it('status dot only on agent and agent-chat tabs, from the Sessions side bar selector', () => {
    render(<NodeTabs {...props({ statuses: { ag: 'blocked', ch: 'done', te: 'working' } })} />)
    const dot = (title: string) => tab(title).querySelector('[role="img"]')
    expect(dot('claude')?.className).toContain('tabs-tab__status--attention')
    expect(dot('claude')?.getAttribute('aria-label')).toBe(sessionSignal('blocked', false).label)
    expect(dot('chat')?.className).toContain('tabs-tab__status--done')
    expect(dot('chat')?.getAttribute('aria-label')).toBe('Done')
    expect(dot('shell')).toBeNull()
    cleanup()
    // Agent Chat waiting on you (needs you) and stopped (side bar ✓) both show.
    render(<NodeTabs {...props({ statuses: { ag: 'working', ch: 'waiting' } })} />)
    expect(dot('claude')?.className).toContain('tabs-tab__status--working')
    expect(dot('chat')?.className).toContain('tabs-tab__status--attention')
    cleanup()
    render(<NodeTabs {...props({ statuses: { ch: 'stopped' } })} />)
    expect(dot('chat')?.className).toContain('tabs-tab__status--done')
    expect(dot('claude')).toBeNull()
  })

  it('an unread Agent Chat shows the unread dot, like the side bar’s unread check', () => {
    render(<NodeTabs {...props()} />)
    expect(tab('chat').querySelector('[role="img"]')).toBeNull()
    act(() => markUnread('ch'))
    const dot = tab('chat').querySelector('[role="img"]')
    expect(dot?.className).toContain('tabs-tab__status--unread')
    expect(dot?.getAttribute('aria-label')).toBe(UNREAD_LABEL)
    act(() => clearUnread('ch'))
    expect(tab('chat').querySelector('[role="img"]')).toBeNull()
  })

  it('click selects only that node, reveals it (camera moves) and makes it tab mode’s active tab', () => {
    render(<NodeTabs {...props()} />)
    fireEvent.click(tab('shell'))
    expect(rf.setNodes).toHaveBeenCalledTimes(1)
    const update = rf.setNodes.mock.calls[0][0] as (prev: Node[]) => Node[]
    expect(update(NODES).filter((n) => n.selected).map((n) => n.id)).toEqual(['te'])
    expect(rf.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'te' }] }))
    expect(getTabLayout().tabs.active).toBe('te')
  })

  it('the selected node’s tab is the active one; nothing selected = none active', () => {
    const { rerender } = render(<NodeTabs {...props()} />)
    expect(screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(0)
    const selected = NODES.map((n) => (n.id === 'br' ? { ...n, selected: true } : n))
    rerender(<NodeTabs {...props({ nodes: selected })} />)
    expect(tab('Browser').getAttribute('aria-selected')).toBe('true')
    expect(tab('Browser').className).toContain('tabs-tab--active')
  })

  it('× and middle click close through onCloseNode (the node-close gate)', () => {
    const p = props()
    render(<NodeTabs {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close claude' }))
    expect(p.onCloseNode).toHaveBeenCalledWith('ag')
    fireEvent(tab('shell'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(p.onCloseNode).toHaveBeenCalledWith('te')
    expect(rf.setNodes).not.toHaveBeenCalled()
  })

  it('a Files tab is draggable and its new position persists', () => {
    const write = vi.fn<(next: TabLayout) => void>()
    connectTabLayout(defaultTabLayout(), write)
    render(<NodeTabs {...props()} />)
    fireEvent.dragStart(tab('repo'), { dataTransfer: { setData: () => {}, effectAllowed: '' } })
    fireEvent.dragOver(tab('claude'))
    fireEvent.drop(tab('claude'))
    expect(write.mock.calls.at(-1)?.[0].tabs.order).toEqual(['ag', 'fi', 'ch', 'br', 'ed', 'te'])
    expect(titles().slice(0, 2)).toEqual(['claude', 'repo'])
  })

  it('drag reorder writes the new order to the persisted workspace layout', () => {
    const write = vi.fn<(next: TabLayout) => void>()
    connectTabLayout(defaultTabLayout(), write)
    render(<NodeTabs {...props()} />)
    // jsdom drag events carry no clientX, so the drop lands on the right half of “claude”.
    const target = tab('claude')
    fireEvent.dragStart(tab('shell'), { dataTransfer: { setData: () => {}, effectAllowed: '' } })
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    expect(getTabLayout().tabs.order).toEqual(['ag', 'te', 'ch', 'br', 'ed', 'fi'])
    expect(write.mock.calls.at(-1)?.[0].tabs.order).toEqual(['ag', 'te', 'ch', 'br', 'ed', 'fi'])
    expect(titles().slice(0, 3)).toEqual(['claude', 'shell', 'chat'])
  })

  it('arrow keys, Home and End move focus between tabs; Enter activates', () => {
    render(<NodeTabs {...props()} />)
    tab('claude').focus()
    fireEvent.keyDown(tab('claude'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('chat'))
    fireEvent.keyDown(tab('chat'), { key: 'End' })
    expect(document.activeElement).toBe(tab('shell'))
    fireEvent.keyDown(tab('shell'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tab('claude'))
    fireEvent.keyDown(tab('claude'), { key: 'Enter' })
    expect(rf.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'ag' }] }))
    expect(nextTabIndex('a', 0, 3)).toBe(-1)
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2)
  })
})

describe('overflow', () => {
  // Tabs are 100px wide side by side; the visible list is 250px, so tabs 3.. do not fit.
  function layOut() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement
      const at = el.dataset.tabId ? [...el.parentElement!.children].indexOf(el) : -1
      const left = at < 0 ? 0 : at * 100
      const width = at < 0 ? 250 : 100
      return { left, right: left + width, width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON: () => ({}) }
    })
  }

  it('lists the tabs that do not fit behind “⋯ N more”, filterable, and picking one activates it', () => {
    layOut()
    render(<NodeTabs {...props()} />)
    const more = screen.getByRole('button', { name: '4 more tabs' })
    expect(more.textContent).toBe('⋯ 4 more')
    fireEvent.click(more)
    const input = screen.getByPlaceholderText('Filter hidden tabs')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Browser', 'api.ts', 'repo', 'shell'])
    fireEvent.change(input, { target: { value: 'she' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['shell'])
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByPlaceholderText('Filter hidden tabs')).toBeNull()
    expect(rf.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'te' }] }))
  })

  it('no button when everything fits', () => {
    render(<NodeTabs {...props()} />)
    expect(screen.queryByRole('button', { name: /more tabs/ })).toBeNull()
  })

  it('hiddenTabIds counts tabs cut off on either side', () => {
    const list = document.createElement('div')
    list.innerHTML = '<div data-tab-id="a"></div><div data-tab-id="b"></div><div data-tab-id="c"></div>'
    const rects: Record<string, [number, number]> = { a: [-50, 50], b: [50, 150], c: [150, 260] }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [left, right] = rects[(this as HTMLElement).dataset.tabId ?? ''] ?? [0, 200]
      return { left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }
    })
    expect(hiddenTabIds(list)).toEqual(['a', 'c'])
  })
})

describe('Show Node Tabs toggle', () => {
  beforeEach(() => { localStorage.clear(); reloadNodeTabsShown() })

  it('is on by default and persists across reloads', () => {
    expect(nodeTabsShown()).toBe(true)
    toggleNodeTabs()
    expect(nodeTabsShown()).toBe(false)
    expect(localStorage.getItem('webterm.nodeTabs')).toBe('0')
    reloadNodeTabsShown()
    expect(nodeTabsShown()).toBe(false)
    setNodeTabsShown(true)
    reloadNodeTabsShown()
    expect(nodeTabsShown()).toBe(true)
  })

  it('re-renders subscribers', () => {
    function Probe() { return <span>{useNodeTabsShown() ? 'on' : 'off'}</span> }
    render(<Probe />)
    expect(screen.getByText('on')).toBeTruthy()
    act(() => toggleNodeTabs())
    expect(screen.getByText('off')).toBeTruthy()
  })
})

describe('nodeTabItems', () => {
  it('keeps stored order, drops gone ids, appends nodes the order lacks', () => {
    const items = nodeTabItems(NODES, ['te', 'gone', 'ag'], {})
    expect(items.map((i) => i.id)).toEqual(['te', 'ag', 'ch', 'br', 'ed', 'fi'])
    // Same selector as tab mode and the side bar: one signal per node.
    expect(nodeTabItems(NODES, [], { ch: 'blocked' }).find((i) => i.id === 'ch')?.signal).toEqual(nodeTabSignal('agentChat', 'blocked', false))
  })
})
