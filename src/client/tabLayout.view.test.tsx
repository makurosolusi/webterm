/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Node } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import { FILES_PANEL_WIDTH, defaultTabLayout } from '../shared/tabLayout.schema'
import { getNodeHost, releaseNodeHost } from './tabLayout.dom'
import { connectTabLayout, getTabLayout, setMode } from './tabLayout.store'
import TabsView, { type TabsViewProps } from './tabLayout.view'
import { movedOrder } from './tabLayout.strip'
import { sessionSignal } from './sessionSignal'

const node = (id: string, type: string, title?: string): Node => ({ id, type, position: { x: 0, y: 0 }, data: { title } })
const NODES = [node('a', 'terminal', 'alpha'), node('b', 'agent', 'beta'), node('c', 'browser', 'gamma'), node('f', 'files', 'tree')]

const props = (over: Partial<TabsViewProps> = {}): TabsViewProps => ({
  nodes: NODES, statuses: {}, onCloseNode: vi.fn(), onRenameNode: vi.fn(),
  onAddTerminal: vi.fn(), onAddAgent: vi.fn(), onAddDiff: vi.fn(), onAddFiles: vi.fn(), ...over,
})
const pane = (id: string) => document.querySelector<HTMLElement>(`.tabs-area [data-tab-node][data-id="${id}"]`)
const tab = (title: string) => screen.getByText(title).closest<HTMLElement>('[role="tab"]')!

beforeEach(() => connectTabLayout({ ...defaultTabLayout(), mode: 'tabs' }, null))
afterEach(() => { cleanup(); for (const id of ['a', 'b', 'c', 'd', 'f', 'h']) releaseNodeHost(id) })

describe('TabsView', () => {
  it('reconciles one tab per non-files node, with a pane each and only the active one shown', () => {
    render(<TabsView {...props()} />)
    // Files is in the saved order (canvas strip) but docked here, not a tab.
    expect(getTabLayout().tabs.order).toEqual(['a', 'b', 'c', 'f'])
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['alpha', 'beta', 'gamma'])
    const shown = ['a', 'b', 'c'].filter((id) => pane(id)!.style.display !== 'none')
    expect(shown).toEqual([getTabLayout().tabs.active])
  })

  it('places each node host inside its pane and keeps it there while switching tabs', () => {
    render(<TabsView {...props()} />)
    for (const id of ['a', 'b', 'c']) expect(getNodeHost(id).parentElement).toBe(pane(id))
    fireEvent.click(tab('alpha'))
    expect(getTabLayout().tabs.active).toBe('a')
    expect(pane('a')!.style.display).not.toBe('none')
    expect(pane('c')!.style.display).toBe('none')
    expect(getNodeHost('c').parentElement).toBe(pane('c'))
  })

  it('close button and middle click call onCloseNode', () => {
    const p = props()
    render(<TabsView {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close beta' }))
    expect(p.onCloseNode).toHaveBeenCalledWith('b')
    fireEvent(tab('gamma'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(p.onCloseNode).toHaveBeenCalledWith('c')
  })

  it('double click renames inline: Enter commits, Escape cancels', () => {
    const p = props()
    render(<TabsView {...p} />)
    fireEvent.doubleClick(screen.getByText('alpha'))
    const input = screen.getByLabelText('Rename tab')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.onRenameNode).toHaveBeenCalledWith('a', 'renamed')
    fireEvent.doubleClick(screen.getByText('alpha'))
    fireEvent.keyDown(screen.getByLabelText('Rename tab'), { key: 'Escape' })
    expect(p.onRenameNode).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Rename tab')).toBeNull()
  })

  it('drag reorder writes the new order to the store', () => {
    render(<TabsView {...props()} />)
    const dt = { setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(tab('alpha'), { dataTransfer: dt })
    fireEvent.dragOver(tab('gamma'), { dataTransfer: dt, clientX: 10_000 }) // jsdom rects are 0-wide: right half
    fireEvent.drop(tab('gamma'), { dataTransfer: dt })
    // The docked Files node keeps its slot in the shared order.
    expect(getTabLayout().tabs.order).toEqual(['b', 'c', 'a', 'f'])
    expect(movedOrder(['a', 'b', 'c'], 'c', 'a', 'left')).toEqual(['c', 'a', 'b'])
  })

  it('adds and removes tabs as nodes change; a new node becomes the active tab', () => {
    const { rerender } = render(<TabsView {...props()} />)
    rerender(<TabsView {...props({ nodes: [...NODES, node('d', 'terminal', 'delta')] })} />)
    expect(getTabLayout().tabs.order).toEqual(['a', 'b', 'c', 'f', 'd'])
    expect(getTabLayout().tabs.active).toBe('d')
    rerender(<TabsView {...props({ nodes: NODES.filter((n) => n.id !== 'd' && n.id !== 'b') })} />)
    expect(getTabLayout().tabs.order).toEqual(['a', 'c', 'f'])
    expect(pane('b')).toBeNull()
  })

  it('shows agent and agent-chat status as a labelled dot, same selector as the canvas strip', () => {
    const nodes = [...NODES, node('h', 'agentChat', 'chat')]
    render(<TabsView {...props({ nodes, statuses: { b: 'blocked', a: 'working', h: 'done' } })} />)
    expect(within(tab('beta')).getByRole('img', { name: sessionSignal('blocked', false).label })).toBeTruthy()
    expect(within(tab('chat')).getByRole('img', { name: 'Done' })).toBeTruthy()
    expect(within(tab('alpha')).queryByRole('img')).toBeNull() // terminals carry no dot
    expect(within(tab('gamma')).queryByRole('img')).toBeNull()
  })

  it('shows the empty state with create buttons when there are no tabs', () => {
    const p = props({ nodes: [] })
    render(<TabsView {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }))
    expect(p.onAddTerminal).toHaveBeenCalled()
  })

  it('back to canvas switches the mode', () => {
    render(<TabsView {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to canvas' }))
    expect(getTabLayout().mode).toBe('canvas')
    setMode('tabs')
  })
})

describe('Files panel', () => {
  const dock = () => document.querySelector<HTMLElement>('.tabs-files')!

  it('holds the first files node host; closing hides the panel without detaching the host', () => {
    render(<TabsView {...props()} />)
    const slot = dock().querySelector('[data-tab-node][data-id="f"]')
    expect(getNodeHost('f').parentElement).toBe(slot)
    fireEvent.click(screen.getByRole('button', { name: 'Close Files panel' }))
    expect(getTabLayout().tabs.filesPanel.open).toBe(false)
    expect(dock().style.display).toBe('none')
    expect(getNodeHost('f').parentElement).toBe(slot)
    expect(slot!.isConnected).toBe(true)
  })

  it('resize handle drives the stored width, clamped', () => {
    render(<TabsView {...props()} />)
    const sep = screen.getByRole('separator', { name: 'Resize Files panel' })
    const start = getTabLayout().tabs.filesPanel.width
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 })
    fireEvent(window, new MouseEvent('pointermove', { clientX: 450 }))
    expect(getTabLayout().tabs.filesPanel.width).toBe(start + 50)
    fireEvent(window, new MouseEvent('pointermove', { clientX: -9000 }))
    expect(getTabLayout().tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.max)
    fireEvent(window, new MouseEvent('pointermove', { clientX: 9000 }))
    expect(getTabLayout().tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.min)
    fireEvent(window, new MouseEvent('pointerup'))
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(getTabLayout().tabs.filesPanel.width).toBe(FILES_PANEL_WIDTH.min + 16)
  })

  it('without a files node shows Open Files', () => {
    const p = props({ nodes: NODES.filter((n) => n.id !== 'f') })
    render(<TabsView {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Files' }))
    expect(p.onAddFiles).toHaveBeenCalled()
  })

  it('the + menu offers New Terminal and calls the handler', () => {
    const p = props()
    render(<TabsView {...p} />)
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'New tab' })) })
    fireEvent.click(screen.getByRole('menuitem', { name: /New Terminal/ }))
    expect(p.onAddTerminal).toHaveBeenCalled()
  })
})
