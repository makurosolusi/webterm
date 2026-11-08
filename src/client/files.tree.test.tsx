/** @vitest-environment jsdom */
// Files node as a TREE with the file-manager click model: one click opens a file after a
// short wait, a double click renames instead, a folder click toggles in place; tree keys; expanded
// folders persisted per node; selection keyed by relative path survives a refresh.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fs = vi.hoisted(() => ({
  list: vi.fn(), mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
}))
vi.mock('./fsClient', async () => ({ ...fs, ...(await import('./filesCaps.fixture')).capsMock() }))
const openFile = vi.hoisted(() => vi.fn())
vi.mock('./useFilesOpen', async (orig) => {
  const m = await orig<typeof import('./useFilesOpen')>()
  return { useFilesOpen: (a: Parameters<typeof m.useFilesOpen>[0]) => ({ ...m.useFilesOpen(a), openFile }) }
})
const renameAt = vi.hoisted(() => vi.fn())
vi.mock('./filesSlot.mutate', async (orig) => ({ ...(await orig<object>()), renameAt }))
const updateNodeData = vi.hoisted(() => vi.fn())
vi.mock('@xyflow/react', async (orig) => {
  const m = await orig<typeof import('@xyflow/react')>()
  return {
    ...m,
    useReactFlow: () => {
      const rf = m.useReactFlow()
      return { ...rf, updateNodeData: (...a: Parameters<typeof rf.updateNodeData>) => { updateNodeData(...a); rf.updateNodeData(...a) } }
    },
  }
})

import FilesNode from './FilesNode'
import { CLICK_OPEN_DELAY_MS } from './FilesList'
import { FILES_SLOTS, type FilesSlot, type FilesSlotCtx } from './filesSlots'

// test-only fixture: /proj = src/ (lib/, a.ts), b.ts ; /proj/src/lib = deep.ts
const LISTING: Record<string, { name: string; dir: boolean }[]> = {
  '/proj': [{ name: 'src', dir: true }, { name: 'b.ts', dir: false }],
  '/proj/src': [{ name: 'lib', dir: true }, { name: 'a.ts', dir: false }],
  '/proj/src/lib': [{ name: 'deep.ts', dir: false }],
}

const names = (c: HTMLElement) => [...c.querySelectorAll('.files-row .files-name')].map((e) => e.textContent)
const list = (c: HTMLElement) => c.querySelector('.files-list') as HTMLElement
const rowOf = (c: HTMLElement, leaf: string) =>
  [...c.querySelectorAll<HTMLElement>('.files-row')].find((r) => r.querySelector('.files-name')?.textContent === leaf) as HTMLElement
const cursor = (c: HTMLElement) => c.querySelector('.files-row--cursor .files-name')?.textContent
const key = (c: HTMLElement, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(list(c), { key: k, ...init })
const click = (c: HTMLElement, leaf: string, init: MouseEventInit = {}) => fireEvent.click(rowOf(c, leaf), { detail: 1, ...init })
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)))

async function mount(data: Record<string, unknown> = {}, expectRows = 2) {
  fs.list.mockImplementation((p: string) => Promise.resolve(LISTING[p] ?? []))
  const r = render(
    <ReactFlowProvider>
      <FilesNode {...({ id: 'f1', data: { dirPath: '/proj', title: 't', ...data }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
    </ReactFlowProvider>,
  )
  await waitFor(() => expect(names(r.container)).toHaveLength(expectRows))
  list(r.container).focus()
  return r.container
}

afterEach(() => {
  cleanup()
  while (FILES_SLOTS.length > 7) (FILES_SLOTS as FilesSlot[]).pop()
  Object.values(fs).forEach((m) => m.mockReset())
  openFile.mockReset(); renameAt.mockReset(); updateNodeData.mockReset()
})

describe('click model', () => {
  it('one click selects at once and opens the file after the delay, focus staying in the tree', async () => {
    const c = await mount()
    click(c, 'b.ts')
    expect(cursor(c)).toBe('b.ts')
    expect(openFile).not.toHaveBeenCalled()
    await wait(CLICK_OPEN_DELAY_MS + 50)
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile).toHaveBeenCalledWith('/proj/b.ts', { focusEditor: false })
  })

  it('double click renames (relative path) and never opens', async () => {
    const c = await mount()
    const canvas = vi.fn()
    document.addEventListener('dblclick', canvas)
    click(c, 'b.ts'); click(c, 'b.ts', { detail: 2 }); fireEvent.dblClick(rowOf(c, 'b.ts'))
    document.removeEventListener('dblclick', canvas)
    expect(canvas).not.toHaveBeenCalled() // React Flow would zoom the canvas in on it
    await wait(CLICK_OPEN_DELAY_MS + 50)
    expect(renameAt).toHaveBeenCalledTimes(1)
    expect(renameAt.mock.calls[0][1]).toBe('b.ts')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('folder click expands in place (lazy listing, indented children), a second click collapses', async () => {
    const c = await mount()
    click(c, 'src')
    await waitFor(() => expect(names(c)).toEqual(['src', 'lib', 'a.ts', 'b.ts']))
    expect(fs.list).toHaveBeenCalledWith('/proj/src')
    expect(rowOf(c, 'a.ts').style.getPropertyValue('--files-depth')).toBe('1')
    expect(rowOf(c, 'src').closest('vscode-tree-item')?.getAttribute('aria-expanded')).toBe('true')
    expect(openFile).not.toHaveBeenCalled()
    click(c, 'src')
    expect(names(c)).toEqual(['src', 'b.ts'])
  })

  it('double click on a folder renames it and leaves its expansion as it was', async () => {
    const c = await mount()
    click(c, 'src'); click(c, 'src', { detail: 2 }); fireEvent.dblClick(rowOf(c, 'src'))
    await wait(50)
    expect(names(c)).toEqual(['src', 'b.ts'])
    expect(renameAt.mock.calls[0][1]).toBe('src')
  })

  it('Cmd/Shift click multi-selects without opening or toggling', async () => {
    const c = await mount()
    click(c, 'b.ts', { metaKey: true }); click(c, 'src', { shiftKey: true })
    await wait(CLICK_OPEN_DELAY_MS + 50)
    expect([...c.querySelectorAll('.files-row--sel .files-name')].map((e) => e.textContent)).toEqual(['src', 'b.ts'])
    expect(names(c)).toEqual(['src', 'b.ts'])
    expect(openFile).not.toHaveBeenCalled()
  })
})

describe('tree keys', () => {
  it('Right expands then steps in; Left jumps to the parent then collapses', async () => {
    const c = await mount()
    key(c, 'ArrowDown'); expect(cursor(c)).toBe('src')
    key(c, 'ArrowRight')
    await waitFor(() => expect(names(c)).toEqual(['src', 'lib', 'a.ts', 'b.ts']))
    key(c, 'ArrowRight'); expect(cursor(c)).toBe('lib')
    key(c, 'ArrowDown'); expect(cursor(c)).toBe('a.ts')
    key(c, 'ArrowLeft'); expect(cursor(c)).toBe('src')
    key(c, 'ArrowLeft'); expect(names(c)).toEqual(['src', 'b.ts'])
  })

  it('Enter opens a file, Space opens it keeping focus, Enter on a folder toggles it', async () => {
    const c = await mount()
    key(c, 'End'); key(c, 'Enter')
    expect(openFile).toHaveBeenLastCalledWith('/proj/b.ts', { focusEditor: true })
    key(c, ' ')
    expect(openFile).toHaveBeenLastCalledWith('/proj/b.ts', { focusEditor: false })
    key(c, 'Home'); key(c, 'Enter')
    await waitFor(() => expect(names(c)).toHaveLength(4))
    expect(openFile).toHaveBeenCalledTimes(2)
  })

  it('Backspace no longer goes up: the node keeps its folder and the key never reaches the canvas', async () => {
    const c = await mount()
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    key(c, 'ArrowDown'); key(c, 'Backspace')
    document.removeEventListener('keydown', leaked)
    expect(leaked).not.toHaveBeenCalled()
    expect(updateNodeData).not.toHaveBeenCalledWith('f1', expect.objectContaining({ dirPath: expect.anything() }))
  })
})

describe('persistence and refresh', () => {
  it('expanding persists `expanded` on the node; a node mounted with it comes back expanded', async () => {
    const c = await mount()
    click(c, 'src')
    expect(updateNodeData).toHaveBeenLastCalledWith('f1', { expanded: ['src'] })
    cleanup()
    const again = await mount({ expanded: ['src', 'src/lib'] }, 5)
    expect(names(again)).toEqual(['src', 'lib', 'deep.ts', 'a.ts', 'b.ts'])
  })

  it('slots see relative paths; selection by relative path and expansion survive a refresh', async () => {
    let seen: FilesSlotCtx | null = null
    const decorated: string[] = []
    ;(FILES_SLOTS as FilesSlot[]).push({
      id: 'probe',
      useSlot: (ctx) => { seen = ctx },
      decorate: (e) => { decorated.push(e.name); return undefined },
    })
    const c = await mount({ expanded: ['src'] }, 4)
    click(c, 'a.ts', { metaKey: true })
    const ctx = () => seen as unknown as FilesSlotCtx
    expect(ctx().selection).toEqual(['src/a.ts'])
    expect(ctx().entries.map((e) => e.name)).toEqual(['src', 'src/lib', 'src/a.ts', 'b.ts'])
    expect(decorated).toContain('src/a.ts')
    expect([...ctx().expanded]).toEqual(['src'])
    const calls = fs.list.mock.calls.length
    act(() => ctx().refresh())
    await waitFor(() => expect(fs.list.mock.calls.length).toBeGreaterThanOrEqual(calls + 2))
    await wait(0)
    expect(names(c)).toEqual(['src', 'lib', 'a.ts', 'b.ts'])
    expect(ctx().selection).toEqual(['src/a.ts'])
    act(() => ctx().collapseAll())
    expect(names(c)).toEqual(['src', 'b.ts'])
  })
})

it('FilesNode.tsx stays under the 300-line component budget', () => {
  const src = readFileSync(join(__dirname, 'FilesNode.tsx'), 'utf8')
  expect(src.split('\n').length).toBeLessThan(300)
})
