import { expect, it, vi } from 'vitest'
import { FILES_SLOTS } from './filesSlots'

const slot = (id: string) => FILES_SLOTS.find((s) => s.id === id)

it('urutan slot tetap (kontrak §5.4) dan id unik', () => {
  expect(FILES_SLOTS.map((s) => s.id)).toEqual(['mutate', 'git', 'watch', 'search', 'dnd', 'upload', 'tree'])
})

it('mutate: menu + onKey + overlay + useSlot + decorate (cut rows), no toolbar', () => {
  const s = slot('mutate')
  expect(s?.menu).toBeTypeOf('function')
  expect(s?.onKey).toBeTypeOf('function')
  expect(s?.overlay).toBeTypeOf('function')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.decorate).toBeTypeOf('function')
  expect(s?.toolbar).toBeUndefined()
})

it('git hanya boleh decorate; watch (stub) tidak menambah menu/dekorasi/toolbar/tombol', () => {
  for (const id of ['git', 'watch']) {
    const s = slot(id)
    expect(s?.menu, id).toBeUndefined()
    expect(s?.toolbar, id).toBeUndefined()
    expect(s?.onKey, id).toBeUndefined()
    if (id !== 'git') expect(s?.decorate, id).toBeUndefined()
  }
})

it('search (nyata, WS-FM-09): useSlot + overlay, tanpa menu/toolbar/onKey/decorate', () => {
  const s = slot('search')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.overlay).toBeTypeOf('function')
  expect(s?.menu).toBeUndefined()
  expect(s?.toolbar).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
  expect(s?.decorate).toBeUndefined()
})

it('dnd (nyata, WS-FM-09): useSlot + menu, tanpa toolbar/onKey/decorate/overlay', () => {
  const s = slot('dnd')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.menu).toBeTypeOf('function')
  expect(s?.toolbar).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
  expect(s?.decorate).toBeUndefined()
  expect(s?.overlay).toBeUndefined()
})

it('upload (WS-FM-10): menu + toolbar icon + conflict overlay + useSlot (drop), no decorate/onKey', () => {
  const s = slot('upload')
  expect(s?.menu).toBeTypeOf('function')
  expect(s?.toolbar).toBeTypeOf('function')
  expect(s?.overlay).toBeTypeOf('function')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.decorate).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
})

it('footer (C2) is optional; when a slot has one it is a function', () => {
  for (const s of FILES_SLOTS) if (s.footer !== undefined) expect(s.footer, s.id).toBeTypeOf('function')
})

it('tree: useSlot + menu only; Collapse All offered only while a folder is expanded, and it collapses', () => {
  const s = slot('tree')
  expect(s?.useSlot).toBeTypeOf('function')
  expect(s?.toolbar).toBeUndefined()
  expect(s?.onKey).toBeUndefined()
  expect(s?.decorate).toBeUndefined()
  const base = {
    cwd: '/p', dir: '/p', entries: [], selection: [], nodeId: 'tree-test', toggle: vi.fn(), startRenameAt: vi.fn(),
    refresh: vi.fn(), open: vi.fn(), startInput: vi.fn(), notify: () => '', dismiss: vi.fn(),
  }
  expect(s!.menu!({ ...base, expanded: new Set(), collapseAll: vi.fn() })).toEqual([])
  const collapseAll = vi.fn()
  const rows = s!.menu!({ ...base, expanded: new Set(['src']), collapseAll })
  expect(rows.map((r) => ('label' in r ? r.label : r.type))).toEqual(['Collapse All'])
  ;(rows[0] as { onClick(): void }).onClick()
  expect(collapseAll).toHaveBeenCalledTimes(1)
})

it('the tree rows appear once in the menu: dnd no longer serves them', () => {
  const rows = FILES_SLOTS.flatMap((s) => s.menu?.({
    cwd: '/p', dir: '/p', entries: [], selection: [], nodeId: 'once', expanded: new Set(['src']), toggle: vi.fn(),
    collapseAll: vi.fn(), startRenameAt: vi.fn(), refresh: vi.fn(), open: vi.fn(), startInput: vi.fn(), notify: () => '', dismiss: vi.fn(),
  }) ?? [])
  expect(rows.filter((r) => 'label' in r && r.label === 'Collapse All')).toHaveLength(1)
})
