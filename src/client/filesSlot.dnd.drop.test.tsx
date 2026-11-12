/** @vitest-environment jsdom */
// Tree DnD (move / Alt-copy / refuse into itself / keep-both), terminal payload kept, Collapse All, Open in Browser.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileMeta } from '../shared/fsContract'

const fs = vi.hoisted(() => ({
  capabilities: vi.fn(), rename: vi.fn(), copy: vi.fn(), list: vi.fn(), rawUrl: (p: string) => `/api/fs/raw?path=${encodeURIComponent(p)}`,
}))
vi.mock('./fsClient', () => fs)

import FilesToolbar from './FilesToolbar'
import { DND_MIME, dndSlot, resetDndSlot } from './filesSlot.dnd'
import { DROP_TEXT, MOVE_MIME, MOVE_ROW_ATTR } from './filesSlot.dnd.drop'
import { TREE_TEXT, treeSlot } from './filesSlot.tree'
import type { FilesSlotCtx, SlotMenuRow } from './filesSlots'
import { popUndo } from './filesUndo'
import { onFsEvent } from './fsEvents'
import { NodeActionsProvider } from './nodeActions'

const caps = { mutate: true, viewers: false, watch: false, git: false, quickOpen: true, upload: false, listMax: 1 }
const ent = (name: string, dir = false): FileMeta => ({ name, dir, ignored: false })
const ENTRIES = [ent('src', true), ent('src/lib', true), ent('src/a.ts'), ent('b.txt'), ent('page.html')]
const mkCtx = (o: Partial<FilesSlotCtx> = {}): FilesSlotCtx => ({
  cwd: '/p', dir: '/p', entries: ENTRIES, selection: [], refresh: vi.fn(), open: vi.fn(), startInput: vi.fn(), nodeId: 'n1',
  notify: vi.fn(() => ''), dismiss: vi.fn(), expanded: new Set(), toggle: vi.fn(), collapseAll: vi.fn(), startRenameAt: vi.fn(), ...o,
})

/** Files node DOM as the tree renders it: one `vscode-tree-item[data-index]` per entry, label = last segment. */
function mount(entries: FileMeta[]): HTMLElement {
  const node = document.createElement('div')
  node.setAttribute('data-id', 'n1')
  const body = document.createElement('div')
  body.className = 'files-node'
  entries.forEach((e, i) => {
    const row = document.createElement('vscode-tree-item')
    row.setAttribute('data-index', String(i))
    const name = document.createElement('span')
    name.className = 'files-name'
    name.textContent = e.name.split('/').pop()!
    name.title = e.name
    row.appendChild(name)
    body.appendChild(row)
  })
  node.appendChild(body)
  document.body.appendChild(node)
  return node
}
const rowOf = (node: HTMLElement, i: number) => node.querySelectorAll('.files-name')[i]

/** One drag: dragstart on row `from`, then dragenter/dragover/drop on `to` sharing the same dataTransfer. */
function dragTo(from: Element, to: Element, altKey = false) {
  const data = new Map<string, string>()
  const dataTransfer = {
    setData: (k: string, v: string) => { data.set(k, v) }, getData: (k: string) => data.get(k) ?? '',
    get types() { return [...data.keys()] }, effectAllowed: '', dropEffect: '',
  }
  const fire = (target: Element, type: string) => {
    const ev = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(ev, { dataTransfer, altKey })
    act(() => { target.dispatchEvent(ev) })
    return ev
  }
  fire(from, 'dragstart')
  fire(to, 'dragenter')
  const over = fire(to, 'dragover')
  return { data, dataTransfer, over, drop: () => fire(to, 'drop') }
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  resetDndSlot()
  fs.capabilities.mockResolvedValue(caps)
  fs.rename.mockResolvedValue({ ok: true })
  fs.copy.mockResolvedValue({ ok: true })
  fs.list.mockResolvedValue([])
})
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.clearAllMocks(); vi.restoreAllMocks() })

describe('drag inside the tree', () => {
  it('dropping a row on a folder row renames it into that folder, and the terminal payload is still there', async () => {
    const node = mount(ENTRIES)
    const ctx = mkCtx()
    renderHook(() => dndSlot.useSlot?.(ctx))
    await settle()
    const d = dragTo(rowOf(node, 3), rowOf(node, 1))
    expect(d.data.get(DND_MIME)).toBe("'/p/b.txt'")
    expect(d.data.get('text/plain')).toBe("'/p/b.txt'")
    expect(JSON.parse(d.data.get(MOVE_MIME)!)).toEqual(['/p/b.txt'])
    expect(d.dataTransfer.effectAllowed).toBe('copyMove')
    expect(d.over.defaultPrevented).toBe(true)
    expect(d.dataTransfer.dropEffect).toBe('move')
    expect(node.querySelectorAll('vscode-tree-item')[1].hasAttribute(MOVE_ROW_ATTR)).toBe(true)
    d.drop()
    await settle()
    expect(fs.rename).toHaveBeenCalledWith('/p/b.txt', '/p/src/lib/b.txt')
    expect(fs.copy).not.toHaveBeenCalled()
    expect(node.querySelector(`[${MOVE_ROW_ATTR}]`)).toBeNull()
    expect(ctx.refresh).toHaveBeenCalledWith('src/lib/b.txt')
    expect(ctx.notify).toHaveBeenCalledWith({ kind: 'info', text: DROP_TEXT.moved(1, 'lib') })
  })

  it('a drop is undoable (Cmd+Z in that node) and emits the same fs event as a paste', async () => {
    const node = mount(ENTRIES)
    const ctx = mkCtx()
    const seen: unknown[] = []
    const off = onFsEvent((e) => seen.push(e))
    renderHook(() => dndSlot.useSlot?.(ctx))
    await settle()
    dragTo(rowOf(node, 3), rowOf(node, 1)).drop()
    await settle()
    off()
    expect(seen).toContainEqual({ kind: 'renamed', path: '/p/src/lib/b.txt', from: '/p/b.txt', origin: 'local' })
    expect(popUndo('n1')).toEqual({ kind: 'move', pairs: [{ from: '/p/b.txt', to: '/p/src/lib/b.txt' }] })
  })

  it('a multi-selection moves together; dropping on a file row targets that file’s folder', async () => {
    const node = mount(ENTRIES)
    renderHook(() => dndSlot.useSlot?.(mkCtx({ selection: ['b.txt', 'page.html'] })))
    await settle()
    dragTo(rowOf(node, 3), rowOf(node, 2)).drop()
    await settle()
    expect(fs.rename.mock.calls).toEqual([['/p/b.txt', '/p/src/b.txt'], ['/p/page.html', '/p/src/page.html']])
  })

  it('a query-filtered tree (rendered rows != ctx.entries) still resolves rows by path', async () => {
    const node = mount([ENTRIES[1], ENTRIES[3]])
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    dragTo(rowOf(node, 1), rowOf(node, 0)).drop()
    await settle()
    expect(fs.rename).toHaveBeenCalledWith('/p/b.txt', '/p/src/lib/b.txt')
  })

  it('holding Alt/Option copies instead of moving', async () => {
    const node = mount(ENTRIES)
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    const d = dragTo(rowOf(node, 2), rowOf(node, 1), true)
    expect(d.dataTransfer.dropEffect).toBe('copy')
    d.drop()
    await settle()
    expect(fs.copy).toHaveBeenCalledWith('/p/src/a.ts', '/p/src/lib/a.ts')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('Alt-copy into the file’s own folder duplicates it as "a copy.ts"', async () => {
    const node = mount(ENTRIES)
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    dragTo(rowOf(node, 2), rowOf(node, 0), true).drop()
    await settle()
    expect(fs.copy).toHaveBeenCalledWith('/p/src/a.ts', '/p/src/a copy.ts')
  })

  it('a folder dropped into itself or a descendant is refused with a message, nothing is called', async () => {
    const node = mount(ENTRIES)
    const ctx = mkCtx()
    renderHook(() => dndSlot.useSlot?.(ctx))
    await settle()
    const d = dragTo(rowOf(node, 0), rowOf(node, 1))
    expect(d.dataTransfer.dropEffect).toBe('none')
    expect(d.over.defaultPrevented).toBe(false)
    expect((node.querySelector('.files-node') as HTMLElement).dataset.dropHint).toBe(DROP_TEXT.intoSelf('src'))
    d.drop()
    await settle()
    expect(fs.rename).not.toHaveBeenCalled()
    expect(fs.copy).not.toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith({ kind: 'error', text: DROP_TEXT.intoSelf('src') })
  })

  it('a taken name keeps both ("b copy.txt") instead of overwriting', async () => {
    fs.rename.mockResolvedValueOnce({ ok: false, code: 'EEXIST', error: 'exists' }).mockResolvedValueOnce({ ok: true })
    fs.list.mockResolvedValue([{ name: 'b.txt', dir: false, ignored: false }])
    const node = mount(ENTRIES)
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    dragTo(rowOf(node, 3), rowOf(node, 0)).drop()
    await settle()
    expect(fs.rename.mock.calls).toEqual([['/p/b.txt', '/p/src/b.txt'], ['/p/b.txt', '/p/src/b copy.txt']])
    expect(fs.rename.mock.calls.some((c) => c[2] === true)).toBe(false)
  })

  it('without the mutate capability rows still drag to terminals but carry no move payload', async () => {
    fs.capabilities.mockResolvedValue({ ...caps, mutate: false })
    const node = mount(ENTRIES)
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    const d = dragTo(rowOf(node, 3), rowOf(node, 0))
    expect(d.data.get(DND_MIME)).toBe("'/p/b.txt'")
    expect(d.data.has(MOVE_MIME)).toBe(false)
    d.drop()
    await settle()
    expect(fs.rename).not.toHaveBeenCalled()
  })
})

const labels = (rows: SlotMenuRow[] | undefined) => (rows ?? []).map((r) => ('label' in r ? r.label : '-'))
const click = (rows: SlotMenuRow[] | undefined, label: string) => {
  const r = rows?.find((x) => 'label' in x && x.label === label)
  if (!r || !('onClick' in r)) throw new Error(`no menu row ${label}`)
  r.onClick()
}

describe('menu and toolbar', () => {
  it('Collapse All (menu row and toolbar button) calls ctx.collapseAll; hidden/disabled when nothing is expanded', async () => {
    const ctx = mkCtx({ expanded: new Set(['src']) })
    renderHook(() => treeSlot.useSlot?.(ctx))
    await settle()
    click(treeSlot.menu?.(ctx), TREE_TEXT.collapseAll)
    expect(ctx.collapseAll).toHaveBeenCalledTimes(1)
    expect(labels(treeSlot.menu?.(mkCtx()))).not.toContain(TREE_TEXT.collapseAll)

    const view = { hidden: false, sortKey: 'name', sortDir: 'asc' } as const
    const { rerender } = render(<FilesToolbar view={view} onChange={() => {}} ctx={ctx} onNew={() => {}} onRefresh={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: TREE_TEXT.collapseAll }))
    expect(ctx.collapseAll).toHaveBeenCalledTimes(2)
    rerender(<FilesToolbar view={view} onChange={() => {}} ctx={mkCtx()} onNew={() => {}} onRefresh={() => {}} />)
    expect((screen.getByRole('button', { name: TREE_TEXT.collapseAll }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Open in Browser appears only for a single .html file and opens its raw URL in a browser node', async () => {
    const openBrowserAt = vi.fn(() => ({ status: 'created' as const, nodeId: 'b1' }))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NodeActionsProvider value={{ onSession: () => {}, onToggleHideLinks: () => {}, openBrowserAt }}>{children}</NodeActionsProvider>
    )
    renderHook(() => treeSlot.useSlot?.(mkCtx()), { wrapper })
    await settle()
    expect(labels(treeSlot.menu?.(mkCtx({ selection: ['b.txt'] })))).not.toContain(TREE_TEXT.openInBrowser)
    expect(labels(treeSlot.menu?.(mkCtx({ selection: ['src'] })))).not.toContain(TREE_TEXT.openInBrowser)
    expect(labels(treeSlot.menu?.(mkCtx({ selection: ['page.html', 'b.txt'] })))).not.toContain(TREE_TEXT.openInBrowser)
    click(treeSlot.menu?.(mkCtx({ selection: ['page.html'] })), TREE_TEXT.openInBrowser)
    expect(openBrowserAt).toHaveBeenCalledWith({ url: `${window.location.origin}/api/fs/raw?path=%2Fp%2Fpage.html`, anchorNodeId: 'n1' })
  })

  it('Open in Browser is absent when the browser feature is off', async () => {
    renderHook(() => treeSlot.useSlot?.(mkCtx()))
    await settle()
    expect(labels(treeSlot.menu?.(mkCtx({ selection: ['page.html'] })))).not.toContain(TREE_TEXT.openInBrowser)
  })
})
