/** @vitest-environment jsdom */
// Sticky notes on the REAL canvas (App + React Flow in jsdom): created from the pane menu and by double-clicking
// empty canvas, edited in place, saved on Esc (not per keystroke), recolored for the whole selection, read-only
// while the view is locked. jsdom has no layout: this proves wiring and behavior, not pixels or the font.
import { act, fireEvent, screen, waitFor, render, cleanup } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { Workspace, WsNode } from '../shared/workspace'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { setNodeResizeLocked } from './nodeResize/nodeResize.store'
import StickyNode from './StickyNode'
import { stickyHex } from '../shared/sticky.palette'
import './vscode/test-setup'

beforeAll(installCanvasDom)
beforeEach(() => localStorage.clear())
afterEach(() => { act(() => setNodeResizeLocked(false)); unmountCanvas() })

const pane = () => document.querySelector('.react-flow__pane') as HTMLElement
const stickies = () => [...document.querySelectorAll<HTMLElement>('.react-flow__node-sticky')]
const field = () => screen.queryByLabelText('Sticky note text') as HTMLTextAreaElement | null
const puts = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
  .filter(([u, init]) => String(u).startsWith('/api/workspaces/') && init?.method === 'PUT')
const lastSavedStickies = (): WsNode[] => {
  const body = puts().at(-1)?.[1]?.body
  return body ? (JSON.parse(String(body)) as Workspace).nodes.filter((n) => n.kind === 'sticky') : []
}
const SAVE_DEBOUNCE_PAST_MS = 900

async function addFromMenu(): Promise<void> {
  fireEvent.contextMenu(pane(), { clientX: 300, clientY: 200 })
  fireEvent.click(await screen.findByText('Add sticky note'))
  await waitFor(() => expect(stickies()).toHaveLength(1))
}

describe('creating a sticky note', () => {
  it('pane menu: a 180x180 note is born selected, open for typing and focused; Esc saves the text and returns focus to the note', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    await addFromMenu()
    const node = stickies()[0]
    expect(node.style.width).toBe('180px')
    expect(node.style.height).toBe('180px')
    expect(node.classList.contains('selected')).toBe(true)
    await waitFor(() => expect(field()).not.toBeNull())
    expect(document.activeElement).toBe(field())
    expect(field()?.getAttribute('maxlength')).toBe('2000')

    fireEvent.change(field() as HTMLTextAreaElement, { target: { value: 'Rotate the token' } })
    // Typing is local: nothing but the creation save may have reached the server yet.
    const before = puts().length
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: 'Escape' })
    await waitFor(() => expect(field()).toBeNull())
    expect(screen.getByText('Rotate the token')).toBeTruthy()
    expect(screen.getByRole('group', { name: /Sticky note, Lemon: Rotate the token/ })).toBeTruthy()
    await waitFor(() => expect(puts().length).toBeGreaterThan(before), { timeout: SAVE_DEBOUNCE_PAST_MS * 3 })
    expect(lastSavedStickies()).toMatchObject([{ kind: 'sticky', stickyText: 'Rotate the token', stickyColor: 'lemon', width: 180, height: 180 }])
  })

  it('blur saves too, and an empty note shows the placeholder (not stored)', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    await addFromMenu()
    await waitFor(() => expect(field()).not.toBeNull())
    fireEvent.blur(field() as HTMLTextAreaElement)
    await waitFor(() => expect(field()).toBeNull())
    expect(screen.getByText('Type a note')).toBeTruthy()
    await waitFor(() => expect(lastSavedStickies()[0]?.stickyText ?? '').toBe(''), { timeout: SAVE_DEBOUNCE_PAST_MS * 3 })
  })

  it('double-clicking EMPTY canvas creates a note; double-clicking a note edits it instead of creating another', async () => {
    await mountCanvas({ nodes: [], dirs: {} })
    fireEvent.doubleClick(pane(), { clientX: 400, clientY: 300 })
    await waitFor(() => expect(stickies()).toHaveLength(1))
    await waitFor(() => expect(field()).not.toBeNull())
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: 'Escape' })
    await waitFor(() => expect(field()).toBeNull())

    fireEvent.doubleClick(stickies()[0].querySelector('.sticky-note') as HTMLElement)
    await waitFor(() => expect(field()).not.toBeNull())
    expect(stickies()).toHaveLength(1)
  })

  it('a new note takes the last color picked', async () => {
    localStorage.setItem('webterm.sticky.lastColor', 'cyan')
    await mountCanvas({ nodes: [], dirs: {} })
    await addFromMenu()
    expect((stickies()[0].querySelector('.sticky-note') as HTMLElement).style.getPropertyValue('--sticky-bg')).toBe(stickyHex('cyan'))
  })
})

describe('editing', () => {
  const saved: WsNode = { id: 'st-1', kind: 'sticky', x: 0, y: 0, width: 180, height: 180, stickyText: 'Old', stickyColor: 'pink' }

  it('Delete/Backspace in the note field does not delete the node, and the field survives the keystrokes', async () => {
    await mountCanvas({ nodes: [saved], dirs: {} })
    await waitFor(() => expect(stickies()).toHaveLength(1))
    fireEvent.doubleClick(stickies()[0].querySelector('.sticky-note') as HTMLElement)
    await waitFor(() => expect(field()).not.toBeNull())
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: 'Backspace' })
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: 'Delete' })
    expect(stickies()).toHaveLength(1)
    expect(field()?.value).toBe('Old')
  })

  it('Enter on the focused, selected note opens the editor; Esc closes it and focus returns to the note', async () => {
    await mountCanvas({ nodes: [saved], dirs: {} })
    await waitFor(() => expect(stickies()).toHaveLength(1))
    const node = stickies()[0]
    fireEvent.click(node)
    await waitFor(() => expect(node.classList.contains('selected')).toBe(true))
    node.focus()
    fireEvent.keyDown(node, { key: 'Enter' })
    await waitFor(() => expect(field()).not.toBeNull())
    fireEvent.keyDown(field() as HTMLTextAreaElement, { key: 'Escape' })
    await waitFor(() => expect(field()).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(node))
  })

  it('locked view: double-click does not open the editor', async () => {
    await mountCanvas({ nodes: [saved], dirs: {} })
    await waitFor(() => expect(stickies()).toHaveLength(1))
    act(() => setNodeResizeLocked(true))
    fireEvent.doubleClick(stickies()[0].querySelector('.sticky-note') as HTMLElement)
    expect(field()).toBeNull()
    expect(screen.getByText('Old')).toBeTruthy()
  })
})

describe('color toolbar', () => {
  const two = (selected: boolean): Node[] => ['a', 'b'].map((id, i) => ({
    id, type: 'sticky', position: { x: i * 300, y: 0 }, width: 180, height: 180, selected,
    data: { stickyText: id, stickyColor: 'lemon', stickyTag: '' },
  }))
  const bg = (id: string) => (document.querySelector(`.react-flow__node[data-id="${id}"] .sticky-note`) as HTMLElement).style.getPropertyValue('--sticky-bg')

  function mountFlow(nodes: Node[]) {
    return render(
      <ReactFlowProvider>
        <div style={{ width: 1280, height: 800 }}><ReactFlow defaultNodes={nodes} nodeTypes={{ sticky: StickyNode }} fitView /></div>
      </ReactFlowProvider>,
    )
  }

  it('shows 10 named swatches in a group; picking one recolors EVERY selected note and remembers it', async () => {
    mountFlow(two(true))
    const group = await screen.findByRole('group', { name: 'Sticky note color' })
    const swatches = group.querySelectorAll('button')
    expect(swatches).toHaveLength(10)
    expect(screen.getByRole('button', { name: 'Lemon' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Blue' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    await waitFor(() => { expect(bg('a')).toBe(stickyHex('blue')); expect(bg('b')).toBe(stickyHex('blue')) })
    expect(localStorage.getItem('webterm.sticky.lastColor')).toBe('blue')
    // One toolbar for the whole selection, and no label field when several are selected.
    expect(screen.getAllByRole('group', { name: 'Sticky note color' })).toHaveLength(1)
    expect(screen.queryByLabelText('Sticky note label')).toBeNull()
  })

  it('a single selected note has a label field, capped, that shows in the corner on Enter', async () => {
    mountFlow([two(true)[0]])
    const input = (await screen.findByLabelText('Sticky note label')) as HTMLInputElement
    expect(input.maxLength).toBe(24)
    fireEvent.change(input, { target: { value: 'Task' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('.sticky-note__tag')?.textContent).toBe('Task'))
  })

  it('no toolbar when nothing is selected', async () => {
    mountFlow(two(false))
    await waitFor(() => expect(document.querySelectorAll('.sticky-note')).toHaveLength(2))
    expect(screen.queryByRole('group', { name: 'Sticky note color' })).toBeNull()
    cleanup()
  })
})
