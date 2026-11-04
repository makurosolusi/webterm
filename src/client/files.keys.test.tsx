/** @vitest-environment jsdom */
// Fase 2 shell FilesNode (WS-FM-03): keyboard, multi-select, a11y, header, dan slot FILES_SLOTS.
// fsClient dipalsukan; yang diuji DOM yang dirender node.
import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fs = vi.hoisted(() => ({
  list: vi.fn(), mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
}))
// Slot menanyakan kemampuan server; tes shell berjalan dengan semua fitur mati.
vi.mock('./fsClient', async () => ({ ...fs, ...(await import('./filesCaps.fixture')).capsMock() }))

import FilesNode from './FilesNode'
import { FILES_SLOTS, type FilesSlot } from './filesSlots'

const tree = (dirPath = '/proj'): ReactNode => (
  <ReactFlowProvider defaultNodes={[]} defaultEdges={[]}>
    <FilesNode {...({ id: 'f1', data: { dirPath, title: 't' }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
  </ReactFlowProvider>
)
const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}`, dir: false }))
const rows = (c: HTMLElement) => [...c.querySelectorAll('.files-row')] as HTMLElement[]
const list = (c: HTMLElement) => c.querySelector('.files-list') as HTMLElement
const selected = (c: HTMLElement) => [...c.querySelectorAll('.files-row--sel')].map((r) => r.textContent)
const cursor = (c: HTMLElement) => c.querySelector('.files-row--cursor')?.textContent
const key = (c: HTMLElement, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(list(c), { key: k, ...init })
const settle = () => act(async () => {})

async function mount(n = 5) {
  fs.list.mockResolvedValue(names(n))
  const r = render(tree())
  await waitFor(() => expect(rows(r.container)).toHaveLength(n))
  await settle()
  list(r.container).focus()
  return r.container
}

let slots: FilesSlot[]
beforeEach(() => { slots = FILES_SLOTS as FilesSlot[] })
afterEach(() => {
  cleanup()
  while (slots.length > 6) slots.pop()
  vi.restoreAllMocks()
  Object.values(fs).forEach((m) => m.mockReset())
})

describe('a11y dan header', () => {
  it('list role=tree dengan aria-label, multiselectable, dan satu model fokus (activedescendant)', async () => {
    const c = await mount()
    const l = list(c)
    expect(l.getAttribute('role')).toBe('tree')
    expect(l.getAttribute('aria-label')).toBe('Files in proj')
    expect(l.getAttribute('aria-multiselectable')).toBe('true')
    expect(l.hasAttribute('aria-activedescendant')).toBe(false)
    key(c, 'ArrowDown')
    const id = l.getAttribute('aria-activedescendant')
    expect(id).toBeTruthy()
    expect(document.getElementById(id as string)?.textContent).toBe('f00')
    expect(l.getAttribute('tabindex')).toBe('0')
    // Satu tree saja: host vscode-tree diturunkan jadi group supaya tidak ada role=tree bersarang.
    expect(c.querySelectorAll('[role="tree"]')).toHaveLength(1)
    expect(c.querySelector('vscode-tree')?.getAttribute('role')).toBe('group')
  })

  it('notice berada di wilayah live polite', async () => {
    const c = await mount()
    const foot = c.querySelector('.files-foot') as HTMLElement
    expect(foot.getAttribute('role')).toBe('status')
    expect(foot.getAttribute('aria-live')).toBe('polite')
  })

  it('header: ikon folder + deskripsi cwd; nama punya title', async () => {
    const c = await mount(2)
    expect(c.querySelector('.node-icon.codicon-folder')).not.toBeNull()
    expect(c.querySelector('.node-description')?.textContent).toBe('/proj')
    expect(c.querySelector('.files-name')?.getAttribute('title')).toBe('f00')
  })
})

describe('keyboard', () => {
  it('panah, Home, End, PageDown (10 baris saat layout tak terukur), PageUp', async () => {
    const c = await mount(25)
    key(c, 'ArrowDown'); expect(cursor(c)).toBe('f00')
    key(c, 'ArrowDown'); expect(cursor(c)).toBe('f01')
    key(c, 'End'); expect(cursor(c)).toBe('f24')
    key(c, 'Home'); expect(cursor(c)).toBe('f00')
    key(c, 'PageDown'); expect(cursor(c)).toBe('f10')
    key(c, 'PageDown'); key(c, 'PageDown'); expect(cursor(c)).toBe('f24')
    key(c, 'PageUp'); expect(cursor(c)).toBe('f14')
    expect(selected(c)).toEqual(['f14'])
  })

  it('Shift+panah/End memperluas dari anchor; ⌘A memilih semua', async () => {
    const c = await mount(5)
    key(c, 'ArrowDown'); key(c, 'ArrowDown')
    key(c, 'ArrowDown', { shiftKey: true }); key(c, 'ArrowDown', { shiftKey: true })
    expect(selected(c)).toEqual(['f01', 'f02', 'f03'])
    key(c, 'ArrowUp', { shiftKey: true }); key(c, 'ArrowUp', { shiftKey: true }); key(c, 'ArrowUp', { shiftKey: true })
    expect(selected(c)).toEqual(['f00', 'f01'])
    key(c, 'a', { metaKey: true })
    expect(selected(c)).toHaveLength(5)
    expect(c.querySelector('.files-foot')?.textContent).toBe('5 of 5 · 5 selected')
  })

  it('Backspace/Delete/F2/panah diklaim: tidak bocor ke canvas (Backspace menghapus node di React Flow)', async () => {
    const c = await mount(3)
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    for (const k of ['Backspace', 'Delete', 'F2', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'Home', 'a']) key(c, k)
    key(c, 'a', { metaKey: true })
    expect(leaked).not.toHaveBeenCalled()
    key(c, 'Tab')
    expect(leaked).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', leaked)
  })

  it('Delete dan F2 ditawarkan ke slot.onKey dengan ctx (cwd, seleksi, entries); true = ditangani slot', async () => {
    const onKey = vi.fn((e: { key: string }) => ['Delete', 'F2', 'End'].includes(e.key))
    slots.push({ id: 'fake', onKey })
    const c = await mount(3)
    key(c, 'ArrowDown'); onKey.mockClear()
    key(c, 'Delete')
    expect(onKey).toHaveBeenCalledTimes(1)
    const [ev, ctx] = onKey.mock.calls[0] as unknown as [KeyboardEvent, { cwd: string; selection: string[]; entries: unknown[]; nodeId: string }]
    expect(ev.key).toBe('Delete')
    expect(ctx).toMatchObject({ cwd: '/proj', selection: ['f00'], nodeId: 'f1' })
    expect(ctx.entries).toHaveLength(3)
    key(c, 'F2')
    expect(onKey.mock.calls[1][0]).toMatchObject({ key: 'F2' })
    // Slot yang menangani tombol menghentikan FilesNode: End tidak menggeser kursor.
    key(c, 'End')
    expect(cursor(c)).toBe('f00')
    key(c, 'ArrowDown')
    expect(cursor(c)).toBe('f01')
  })

  it('Menu key membuka menu konteks berisi grup bawaan dan baris slot dengan pemisah + shortcut', async () => {
    slots.push({ id: 'fake', menu: () => [{ label: 'Fake action', onClick: vi.fn() }] })
    const c = await mount(3)
    key(c, 'ArrowDown')
    key(c, 'ContextMenu')
    for (const label of ['Open', 'Open in Integrated Terminal', 'New File…', 'Fake action', 'Reveal', 'Refresh', 'Copy Path', 'Copy Relative Path']) {
      expect(await screen.findByText(label)).toBeTruthy()
    }
    expect(screen.getAllByRole('separator').length).toBeGreaterThanOrEqual(3)
    expect(screen.getByText('Enter')).toBeTruthy()
    expect(screen.getByText('⌥⌘C')).toBeTruthy()
  })
})

describe('multi-select pointer', () => {
  it('Shift-klik memilih rentang, ⌘-klik membalik satu entri, klik biasa memusatkan kembali', async () => {
    const c = await mount(5)
    fireEvent.click(rows(c)[1])
    fireEvent.click(rows(c)[3], { shiftKey: true })
    expect(selected(c)).toEqual(['f01', 'f02', 'f03'])
    fireEvent.click(rows(c)[2], { metaKey: true })
    expect(selected(c)).toEqual(['f01', 'f03'])
    fireEvent.click(rows(c)[4])
    expect(selected(c)).toEqual(['f04'])
  })

  it('klik kanan pada baris di dalam seleksi mempertahankan seleksi; di luar seleksi memilih baris itu', async () => {
    const c = await mount(5)
    fireEvent.click(rows(c)[0])
    fireEvent.click(rows(c)[2], { shiftKey: true })
    fireEvent.contextMenu(rows(c)[1])
    expect(selected(c)).toHaveLength(3)
    await screen.findByText('Refresh')
    fireEvent.contextMenu(rows(c)[4])
    expect(selected(c)).toEqual(['f04'])
  })
})

describe('slot', () => {
  it('decorate (badge/title/className) dan toolbar dirender tanpa FilesNode tahu isinya', async () => {
    slots.push({
      id: 'fake',
      decorate: (e) => (e.name === 'f01' ? { badge: 'M', title: 'modified', className: 'is-mod' } : undefined),
      toolbar: () => <button type="button" data-testid="fake-tool">x</button>,
    })
    const c = await mount(3)
    const badge = c.querySelector('.files-badge') as HTMLElement
    expect(badge.textContent).toBe('M')
    expect(badge.title).toBe('modified')
    expect(rows(c)[1].classList.contains('is-mod')).toBe(true)
    expect(rows(c)[0].querySelector('.files-badge')).toBeNull()
    expect(screen.getByTestId('fake-tool')).toBeTruthy()
  })

  it('useSlot dipanggil tiap render dengan ctx', async () => {
    const useSlot = vi.fn()
    slots.push({ id: 'fake', useSlot })
    await mount(2)
    expect(useSlot).toHaveBeenCalled()
    expect(useSlot.mock.calls.at(-1)?.[0]).toMatchObject({ cwd: '/proj', nodeId: 'f1' })
  })
})

describe('listener', () => {
  it('handler pointer dipasang sekali; pindah seleksi tidak memasang ulang', async () => {
    const c = await mount(4)
    const add = vi.spyOn(list(c), 'addEventListener')
    fireEvent.click(rows(c)[1])
    fireEvent.click(rows(c)[2])
    key(c, 'ArrowDown')
    expect(add).not.toHaveBeenCalled()
  })
})
