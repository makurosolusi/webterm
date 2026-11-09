/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import { connectTabLayout, getTabLayout } from './tabLayout.store'
import { revealNode } from './nodeReveal'
import LayersPanel, { type LayersPanelProps } from './layersPanel'

vi.mock('./nodeReveal', async (importOriginal) => ({ ...(await importOriginal<typeof import('./nodeReveal')>()), revealNode: vi.fn() }))

// test-only fixtures: three terminals in a row, 100x50 each.
const mk = (id: string, x: number, title: string, selected = false): Node =>
  ({ id, type: 'terminal', position: { x, y: 0 }, measured: { width: 100, height: 50 }, data: { title }, selected })
let nodes: Node[]

function fakeRf() {
  const rf = {
    getNode: vi.fn((id: string) => nodes.find((n) => n.id === id)),
    getNodes: vi.fn(() => nodes),
    setNodes: vi.fn((u: Node[] | ((prev: Node[]) => Node[])) => { nodes = typeof u === 'function' ? u(nodes) : u }),
    fitBounds: vi.fn(async () => true),
    setCenter: vi.fn(async () => true),
  }
  return rf
}
let rf: ReturnType<typeof fakeRf>
const selectedIds = () => nodes.filter((n) => n.selected).map((n) => n.id)

function mount(over: Partial<LayersPanelProps> = {}) {
  const props: LayersPanelProps = {
    nodes, statuses: {}, rf: { current: rf as unknown as ReactFlowInstance },
    onCloseNode: vi.fn(), onRenameNode: vi.fn(), onAddTerminal: vi.fn(), onAddAgent: vi.fn(), ...over,
  }
  return { props, ...render(<LayersPanel {...props} />) }
}
const row = (text: string) => screen.getAllByRole('treeitem').find((r) => r.textContent?.includes(text)) as HTMLElement
const withGroup = (ids: string[], collapsed = false): TabLayout => {
  const l = defaultTabLayout()
  return { ...l, tabs: { ...l.tabs, order: ['a', 'b', 'c'], groups: [{ id: 'g1', name: 'Servers', collapsed, ids }] } }
}

beforeEach(() => {
  nodes = [mk('a', 0, 'alpha'), mk('b', 200, 'a very long terminal title that will not fit'), mk('c', 400, 'gamma')]
  rf = fakeRf()
  connectTabLayout(defaultTabLayout(), null)
  vi.mocked(revealNode).mockClear()
})
afterEach(cleanup)

describe('LayersPanel', () => {
  it('renders one row per node with the full title and a tooltip', () => {
    mount()
    const long = row('a very long')
    expect(long.getAttribute('title')).toBe('a very long terminal title that will not fit')
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
  })

  it('click selects the node and reveals it', () => {
    mount()
    fireEvent.click(row('gamma'))
    expect(selectedIds()).toEqual(['c'])
    expect(revealNode).toHaveBeenCalledWith(rf, 'c', { x: 400, y: 0, width: 100, height: 50 })
  })

  it('shift-click selects a contiguous range in list order; mod-click toggles one', () => {
    mount()
    fireEvent.click(row('alpha'))
    fireEvent.click(row('gamma'), { shiftKey: true })
    expect(selectedIds()).toEqual(['a', 'b', 'c'])
    cleanup(); mount()
    fireEvent.click(row('gamma'), { metaKey: true })
    expect(selectedIds()).toEqual(['a', 'b'])
  })

  it('selected nodes are highlighted rows', () => {
    nodes[1] = { ...nodes[1], selected: true }
    mount()
    expect(row('a very long').getAttribute('aria-selected')).toBe('true')
    expect(row('alpha').getAttribute('aria-selected')).toBe('false')
  })

  it('clicking a group selects its members and fits the view to them', () => {
    connectTabLayout(withGroup(['b', 'c']), null)
    mount()
    fireEvent.click(row('Servers'))
    expect(selectedIds()).toEqual(['b', 'c'])
    expect(rf.fitBounds).toHaveBeenCalledWith({ x: 200, y: 0, width: 300, height: 50 }, { padding: 0.2, duration: 250 })
  })

  it('the twisty collapses and expands the group', () => {
    connectTabLayout(withGroup(['b', 'c']), null)
    mount()
    expect(row('Servers').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row('Servers').querySelector('[data-twisty]')!)
    expect(getTabLayout().tabs.groups[0].collapsed).toBe(true)
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    expect(rf.fitBounds).not.toHaveBeenCalled()
  })

  it('double-click renames through onRenameNode; an empty value reverts', () => {
    const { props } = mount()
    fireEvent.doubleClick(row('alpha'))
    const input = screen.getByRole('textbox', { name: 'Rename node' })
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onRenameNode).toHaveBeenCalledWith('a', 'renamed')

    fireEvent.doubleClick(row('gamma'))
    const again = screen.getByRole('textbox', { name: 'Rename node' })
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.blur(again)
    expect(props.onRenameNode).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: 'Rename node' })).toBeNull()
    expect(row('gamma')).toBeTruthy()
  })

  it('dropping a node row on a group moves it into that group', () => {
    connectTabLayout(withGroup(['b']), null)
    mount()
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(row('alpha'), { dataTransfer })
    fireEvent.dragOver(row('Servers'), { dataTransfer })
    expect(row('Servers').getAttribute('data-drop')).toBe('into')
    fireEvent.drop(row('Servers'), { dataTransfer })
    expect(getTabLayout().tabs.groups[0].ids).toEqual(['b', 'a'])
  })

  it('hover outlines the node on the canvas and clears on leave and unmount', () => {
    const el = document.createElement('div')
    el.className = 'react-flow__node'
    el.dataset.id = 'a'
    document.body.appendChild(el)
    const { unmount } = mount()
    fireEvent.mouseEnter(row('alpha'))
    expect(el.hasAttribute('data-layer-hover')).toBe(true)
    fireEvent.mouseLeave(row('alpha'))
    expect(el.hasAttribute('data-layer-hover')).toBe(false)
    fireEvent.mouseEnter(row('alpha'))
    unmount()
    expect(el.hasAttribute('data-layer-hover')).toBe(false)
    el.remove()
  })

  it('empty board offers New Terminal and New Agent', () => {
    nodes = []
    const { props } = mount()
    expect(screen.getByText('No nodes yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Agent' }))
    expect(props.onAddTerminal).toHaveBeenCalledTimes(1)
    expect(props.onAddAgent).toHaveBeenCalledTimes(1)
  })

  it('a filter with no match shows "No matching nodes" and Clear Filter restores the rows', () => {
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter layers' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching nodes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filter' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)
  })

  it('keyboard: ArrowDown moves focus, Enter activates, F2 renames', () => {
    mount()
    act(() => row('alpha').focus())
    fireEvent.keyDown(row('alpha'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('a very long'))
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(selectedIds()).toEqual(['b'])
    fireEvent.keyDown(row('a very long'), { key: 'F2' })
    expect(screen.getByRole('textbox', { name: 'Rename node' })).toBeTruthy()
  })

  it('New Group from Selection is disabled with nothing selected and groups the selection otherwise', () => {
    mount()
    expect((screen.getByRole('button', { name: 'New Group from Selection' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    nodes = nodes.map((n) => (n.id === 'a' || n.id === 'c' ? { ...n, selected: true } : n))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'New Group from Selection' }))
    expect(getTabLayout().tabs.groups.map((g) => g.ids)).toEqual([['a', 'c']])
  })
})
