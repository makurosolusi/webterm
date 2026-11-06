/** @vitest-environment jsdom */
// Slot DnD path: quoting shell (diverifikasi ke `sh` sungguhan), payload dragstart, menu clipboard, flag.
import { act, cleanup, renderHook } from '@testing-library/react'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ capabilities: vi.fn() }))
vi.mock('./fsClient', () => fs)

import type { FilesSlotCtx } from './filesSlots'
import { DND_MIME, DND_TEXT, dndSlot, dragNames, resetDndSlot, shellQuote, shellQuoteAll } from './filesSlot.dnd'

const caps = (o: object) => ({ mutate: false, viewers: false, watch: false, git: false, quickOpen: true, upload: false, listMax: 1, ...o })
const mkCtx = (o: Partial<FilesSlotCtx> = {}): FilesSlotCtx => ({
  cwd: '/p', dir: '/p', entries: [], selection: [], refresh: vi.fn(), open: vi.fn(), startInput: vi.fn(), nodeId: 'n1', notify: vi.fn(), dismiss: vi.fn(), ...o,
})
const NASTY = ["it's.txt", 'with space.txt', '$HOME', '`id`', 'say "hi"', 'line\nbreak', 'ünïcödé 日本語.md', "''", 'a;b&c|d', '*.{js,ts}', '\\n']

describe('shellQuote', () => {
  it('wraps in single quotes and escapes an inner quote as \'\\\'\'', () => {
    expect(shellQuote('/p/a.txt')).toBe("'/p/a.txt'")
    expect(shellQuote("/p/it's")).toBe("'/p/it'\\''s'")
    expect(shellQuote('/p/with space')).toBe("'/p/with space'")
    expect(shellQuote('/p/$x`y`"z"')).toBe("'/p/$x`y`\"z\"'")
  })
  it('round-trips every nasty name through a real shell, with no trailing newline of its own', () => {
    for (const n of NASTY) {
      const q = shellQuote(`/p/${n}`)
      expect(q.endsWith('\n')).toBe(false)
      expect(execFileSync('sh', ['-c', `printf %s ${q}`], { encoding: 'utf8' })).toBe(`/p/${n}`)
    }
  })
  it('joins several paths with single spaces', () => {
    expect(shellQuoteAll(['/p/a b', "/p/c'd"])).toBe("'/p/a b' '/p/c'\\''d'")
    expect(execFileSync('sh', ['-c', `printf '%s|' ${shellQuoteAll(['/p/a b', "/p/c'd"])}`], { encoding: 'utf8' })).toBe("/p/a b|/p/c'd|")
    expect(shellQuoteAll([])).toBe('')
  })
})

describe('dragNames', () => {
  it('uses the whole selection only when the dragged row belongs to a multi-selection', () => {
    expect(dragNames('a', ['a', 'b'])).toEqual(['a', 'b'])
    expect(dragNames('c', ['a', 'b'])).toEqual(['c'])
    expect(dragNames('a', ['a'])).toEqual(['a'])
    expect(dragNames('a', [])).toEqual(['a'])
  })
})

function mountNode(names: string[]): HTMLElement {
  const node = document.createElement('div')
  node.setAttribute('data-id', 'n1')
  names.forEach((n, i) => {
    const row = document.createElement('vscode-tree-item')
    row.setAttribute('data-index', String(i))
    const name = document.createElement('span')
    name.className = 'files-name'
    name.textContent = n
    row.appendChild(name)
    node.appendChild(row)
  })
  document.body.appendChild(node)
  return node
}
const drag = (target: Element) => {
  const data = new Map<string, string>()
  const ev = new Event('dragstart', { bubbles: true, cancelable: true })
  const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' }
  Object.assign(ev, { dataTransfer })
  act(() => { target.dispatchEvent(ev) })
  return { data, dataTransfer }
}
const settle = () => act(async () => {})

beforeEach(() => { resetDndSlot(); fs.capabilities.mockResolvedValue(caps({})) })
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.clearAllMocks(); vi.restoreAllMocks() })

describe('dragstart', () => {
  it('rows become draggable and carry the quoted path under both MIME types', async () => {
    const node = mountNode(["it's a.txt", 'b.txt'])
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    expect(node.querySelectorAll('[draggable="true"]')).toHaveLength(2)
    const { data, dataTransfer } = drag(node.querySelector('.files-name')!)
    const want = "'/p/it'\\''s a.txt'"
    expect(data.get(DND_MIME)).toBe(want)
    expect(data.get('text/plain')).toBe(want)
    expect(dataTransfer.effectAllowed).toBe('copy')
  })
  it('dragging a row inside a multi-selection carries every selected path, space-joined', async () => {
    const node = mountNode(['a.txt', 'b c.txt', 'd.txt'])
    renderHook(() => dndSlot.useSlot?.(mkCtx({ selection: ['a.txt', 'b c.txt'] })))
    await settle()
    expect(drag(node.querySelectorAll('.files-name')[0]).data.get('text/plain')).toBe("'/p/a.txt' '/p/b c.txt'")
    expect(drag(node.querySelectorAll('.files-name')[2]).data.get('text/plain')).toBe("'/p/d.txt'")
  })
  it('flag off: rows stay non-draggable and dragstart is ignored', async () => {
    fs.capabilities.mockResolvedValue(caps({ quickOpen: false }))
    const node = mountNode(['a.txt'])
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    expect(node.querySelectorAll('[draggable]')).toHaveLength(0)
    expect(drag(node.querySelector('.files-name')!).data.size).toBe(0)
  })
  it('capabilities throwing fails closed without crashing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fs.capabilities.mockImplementation(() => { throw new Error('mock tanpa export') })
    const node = mountNode(['a.txt'])
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    expect(node.querySelectorAll('[draggable]')).toHaveLength(0)
    expect(dndSlot.menu?.(mkCtx({ selection: ['a.txt'] }))).toEqual([])
    expect(err).toHaveBeenCalled()
  })
})

describe('menu', () => {
  it('copies the shell-quoted selection to the clipboard; empty selection or flag off adds nothing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderHook(() => dndSlot.useSlot?.(mkCtx()))
    await settle()
    expect(dndSlot.menu?.(mkCtx())).toEqual([])
    const rows = dndSlot.menu!(mkCtx({ selection: ['a b', "c'd"] }))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (!('onClick' in row)) throw new Error('baris menu tidak ada')
    expect(row.label).toBe(DND_TEXT.copyQuoted)
    row.onClick()
    expect(writeText).toHaveBeenCalledWith("'/p/a b' '/p/c'\\''d'")
    resetDndSlot()
    expect(dndSlot.menu?.(mkCtx({ selection: ['a'] }))).toEqual([])
  })
})
