/**
 * @vitest-environment jsdom
 */
// Editors close like VS Code's on the REAL canvas: a clean one closes without a
// question, a dirty one asks Save / Don't Save / Cancel, and a selection mixing dirty editors with
// terminals gets ONE dialog for both. Dirtiness is set through the editorDirty registry the editor
// node reports to; the save is a stub that the test resolves.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCanvasDom, mountCanvas, unmountCanvas } from './canvasHarness'
import { setEditorDirty } from './editorDirty'
import { saveCopy } from './nodeCloseConfirm'
import type { WsNode } from '../shared/workspace'

const { sent } = vi.hoisted(() => ({ sent: [] as { t: string; id: string }[] }))
vi.mock('./ws', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ws')>()
  return { ...real, send: (m: { t: string; id: string }) => { sent.push(m) } }
})
// Monaco never loads in jsdom; the node chrome (and its × button) renders without it.
vi.mock('./lazyMonaco', () => ({ loadMonaco: () => new Promise(() => {}) }))

// test-only fixtures
const ed = (id: string, file: string): WsNode => ({ id, kind: 'editor', x: 0, y: 0, width: 420, height: 320, filePath: file })
const edA = ed('ed-a', '/p/a.ts')
const edB = { ...ed('ed-b', '/p/b.ts'), x: 600 }
const term: WsNode = { id: 'term-1', kind: 'terminal', x: 0, y: 400, width: 420, height: 320, cwd: '/', title: 'shell' }
const files = { '/p/a.ts': 'a', '/p/b.ts': 'b' }

beforeAll(installCanvasDom)
beforeEach(() => { sent.length = 0 })
afterEach(() => { for (const id of ['ed-a', 'ed-b']) setEditorDirty(id, false); unmountCanvas() })

const nodeEl = (id: string): HTMLElement => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  if (!el) throw new Error(`node ${id} not rendered`)
  return el as HTMLElement
}
const closeBtn = (id: string): HTMLElement => {
  // The toolbar's custom element carries no title attribute in jsdom: find it by its close icon.
  const el = nodeEl(id).querySelector('.editor-node__actions .codicon-close')?.closest('vscode-toolbar-button')
  if (!el) throw new Error(`no close button on ${id}`)
  return el as HTMLElement
}
const nodeIds = () => Array.from(document.querySelectorAll('.react-flow__node')).map((n) => n.getAttribute('data-id')).sort()
const dialog = () => document.querySelector('[data-slot="vscode-dialog"]')
/** A button of the open dialog (the editor's own toolbar has a Save button too). */
const dlgBtn = (name: string) => within(dialog() as HTMLElement).getByRole('button', { name })
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 20)))
/** A save the test settles by hand, so "closes only after the write" is observable. */
function deferredSave() {
  let settle!: (ok: boolean) => void
  const save = vi.fn(() => new Promise<boolean>((r) => { settle = r }))
  return { save, settle: (ok: boolean) => act(async () => { settle(ok) }) }
}
async function mount(nodes: WsNode[]): Promise<void> {
  await mountCanvas({ nodes, dirs: {}, files })
  document.elementFromPoint = () => null // jsdom has no hit-test
  await flush()
}
async function selectAllAndDelete(ids: string[]): Promise<void> {
  fireEvent.keyDown(document, { key: 'Control' })
  for (const id of ids) fireEvent.click(nodeEl(id))
  fireEvent.keyUp(document, { key: 'Control' })
  await waitFor(() => expect(document.querySelectorAll('.react-flow__node.selected').length).toBe(ids.length))
  fireEvent.keyDown(document, { key: 'Backspace' })
  await waitFor(() => expect(dialog()).not.toBeNull())
}

describe('editor close (canvas)', () => {
  it('two clean editors close without a prompt', async () => {
    await mount([edA, ed('ed-p', '/p/b.ts')])
    fireEvent.click(closeBtn('ed-a'))
    await waitFor(() => expect(nodeIds()).toEqual(['ed-p']))
    fireEvent.click(closeBtn('ed-p'))
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(dialog()).toBeNull()
  })

  it('a dirty editor asks; Save waits for the write, then closes', async () => {
    await mount([edA])
    const { save, settle } = deferredSave()
    setEditorDirty('ed-a', true, save)
    fireEvent.click(closeBtn('ed-a'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(screen.getByText('Save changes to “a.ts”?')).toBeTruthy()
    expect(screen.getByText("Your changes will be lost if you don't save them.")).toBeTruthy()
    // Save is the primary, non-destructive answer: it takes focus, so Enter saves.
    expect(document.activeElement?.textContent).toBe('Save')

    fireEvent.click(dlgBtn('Save'))
    expect(dlgBtn('Saving…').getAttribute('aria-busy')).toBe('true')
    await flush()
    expect(save).toHaveBeenCalledOnce()
    expect(nodeIds()).toEqual(['ed-a']) // write still in flight
    await settle(true)
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(dialog()).toBeNull()
  })

  it('a failed save keeps the editor open', async () => {
    await mount([edA])
    const { save, settle } = deferredSave()
    setEditorDirty('ed-a', true, save)
    fireEvent.click(closeBtn('ed-a'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(dlgBtn('Save'))
    await settle(false)
    await flush()
    expect(dialog()).toBeNull()
    expect(nodeIds()).toEqual(['ed-a'])
  })

  it("Don't Save closes without saving; Cancel keeps", async () => {
    await mount([edA])
    const save = vi.fn(async () => true)
    setEditorDirty('ed-a', true, save)
    fireEvent.click(closeBtn('ed-a'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(dlgBtn('Cancel'))
    await flush()
    expect(dialog()).toBeNull()
    expect(nodeIds()).toEqual(['ed-a'])

    fireEvent.click(closeBtn('ed-a'))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(dlgBtn("Don't Save"))
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(save).not.toHaveBeenCalled()
  })

  it('several dirty editors: one dialog listing them, Save All saves each then closes', async () => {
    await mount([edA, edB])
    const sa = vi.fn(async () => true), sb = vi.fn(async () => true)
    setEditorDirty('ed-a', true, sa)
    setEditorDirty('ed-b', true, sb)
    await selectAllAndDelete(['ed-a', 'ed-b'])
    expect(screen.getByText('Save changes to 2 files?')).toBeTruthy()
    expect(Array.from(dialog()!.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a.ts', 'b.ts'])
    fireEvent.click(dlgBtn('Save All'))
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(sa).toHaveBeenCalledOnce()
    expect(sb).toHaveBeenCalledOnce()
  })

  it('a dirty editor with a terminal: one dialog naming both; Save closes all', async () => {
    await mount([edA, term])
    const save = vi.fn(async () => true)
    setEditorDirty('ed-a', true, save)
    await selectAllAndDelete(['ed-a', 'term-1'])
    expect(screen.getByText('Save changes to “a.ts”?')).toBeTruthy()
    expect(screen.getByText("Your changes will be lost if you don't save them. Its terminal session and any process running in it will end.")).toBeTruthy()
    fireEvent.click(dlgBtn('Save'))
    await waitFor(() => expect(nodeIds()).toEqual([]))
    expect(save).toHaveBeenCalledOnce()
    expect(sent.some((m) => m.t === 'close' && m.id === 'term-1')).toBe(true)
  })

  it('a clean editor with a terminal: the terminal confirm as before', async () => {
    await mount([edA, term])
    await selectAllAndDelete(['ed-a', 'term-1'])
    expect(screen.getByText('Close 2 nodes?')).toBeTruthy()
    expect(screen.getByText('Terminal sessions and their running processes will end.')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Cancel')
  })
})

describe('saveCopy', () => {
  it('lists files only when there are several, and appends what else ends', () => {
    setEditorDirty('x', true); setEditorDirty('y', true)
    const x = { id: 'x', type: 'editor', data: { filePath: '/p/x.md' } }
    const y = { id: 'y', type: 'editor', data: { title: 'y.txt' } }
    expect(saveCopy([x])).toEqual({ title: 'Save changes to “x.md”?', files: [], body: "Your changes will be lost if you don't save them." })
    expect(saveCopy([x, y, { id: 'c', type: 'editor', data: { filePath: '/p/clean' } }])).toMatchObject({ title: 'Save changes to 2 files?', files: ['x.md', 'y.txt'] })
    expect(saveCopy([x, { id: 'b', type: 'browser', data: {} }]).body).toBe("Your changes will be lost if you don't save them. Its browser page will close.")
    setEditorDirty('x', false); setEditorDirty('y', false)
  })
})
