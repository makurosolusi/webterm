/** @vitest-environment jsdom */
// Slot mutate lewat FilesNode nyata (fsClient dipalsukan): Delete -> konfirmasi -> trash -> Undo,
// Shift+Delete, Rename inline, Duplicate, multi-seleksi, error ke bahasa jelas, dan flag mati.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { FsEvent } from '../shared/fsContract'

const fs = vi.hoisted(() => ({
  list: vi.fn(), mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
  remove: vi.fn(), restore: vi.fn(), rename: vi.fn(), copy: vi.fn(),
}))
const caps = vi.hoisted(() => ({ mutate: true }))
vi.mock('./fsClient', async () => {
  const { capsWith } = await import('./filesCaps.fixture')
  return { ...fs, capabilities: async () => capsWith({ mutate: caps.mutate }) }
})

import FilesNode from './FilesNode'
import { onFsEvent } from './fsEvents'
import { mutateSlot } from './filesSlot.mutate'

const entry = (name: string, dir = false) => ({ name, dir })
const rows = (c: HTMLElement) => [...c.querySelectorAll('.files-row')] as HTMLElement[]
const list = (c: HTMLElement) => c.querySelector('.files-list') as HTMLElement
const key = (c: HTMLElement, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(list(c), { key: k, ...init })
const settle = () => act(async () => {})
const ok = <T extends object>(extra?: T) => Promise.resolve({ ok: true, ...extra })

async function mount(names: string[] = ['a.txt', 'b.txt', 'c.txt']) {
  fs.list.mockResolvedValue(names.map((n) => entry(n)))
  const r = render(
    <ReactFlowProvider defaultNodes={[]} defaultEdges={[]}>
      <FilesNode {...({ id: 'f1', data: { dirPath: '/proj', title: 't' }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
    </ReactFlowProvider>,
  )
  await waitFor(() => expect(rows(r.container)).toHaveLength(names.length))
  await settle()
  list(r.container).focus()
  return r.container
}

let events: FsEvent[]
let off: () => void
beforeEach(() => {
  caps.mutate = true
  events = []
  off = onFsEvent((e) => events.push(e))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(window, 'prompt').mockReturnValue('x')
})
afterEach(() => {
  off()
  cleanup()
  vi.restoreAllMocks()
  Object.values(fs).forEach((m) => m.mockReset())
})

describe('Delete -> trash -> Undo', () => {
  it('Delete minta konfirmasi, lalu remove ke trash, toast Undo memanggil restore, event dipancarkan', async () => {
    fs.remove.mockReturnValue(ok({ trashId: 't-1' }))
    fs.restore.mockReturnValue(ok({ path: '/proj/a.txt' }))
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'Delete')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Pindahkan “a.txt” ke Trash?')).toBeTruthy()
    expect(fs.remove).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByText('Pindahkan ke Trash'))
    await settle()
    expect(fs.remove).toHaveBeenCalledWith('/proj/a.txt', false)
    expect(events).toContainEqual({ kind: 'deleted', path: '/proj/a.txt', origin: 'local' })
    expect(await screen.findByText('“a.txt” dipindahkan ke Trash.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByText('Undo'))
    await settle()
    expect(fs.restore).toHaveBeenCalledWith('t-1')
    expect(events).toContainEqual({ kind: 'created', path: '/proj/a.txt', origin: 'local' })
    expect(await screen.findByText('“a.txt” dipulihkan.')).toBeTruthy()
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('Batal pada konfirmasi tidak memanggil remove', async () => {
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'Delete')
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Batal'))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fs.remove).not.toHaveBeenCalled()
  })

  it('Shift+Delete: konfirmasi permanen (fokus awal di Batal), remove permanent=true, tanpa Undo', async () => {
    fs.remove.mockReturnValue(ok())
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'Delete', { shiftKey: true })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Hapus permanen “a.txt”?')).toBeTruthy()
    expect(within(dialog).getByText('Tindakan ini tidak bisa dibatalkan.')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Batal')
    fireEvent.click(within(dialog).getByText('Hapus permanen'))
    await settle()
    expect(fs.remove).toHaveBeenCalledWith('/proj/a.txt', true)
    expect(await screen.findByText('“a.txt” dihapus permanen.')).toBeTruthy()
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('multi-seleksi: sekuensial, satu gagal tidak menghentikan sisanya, ringkasan memakai bahasa jelas', async () => {
    fs.remove
      .mockReturnValueOnce(ok({ trashId: 't-a' }))
      .mockReturnValueOnce(Promise.resolve({ ok: false, code: 'EACCES', error: 'EACCES: permission denied' }))
      .mockReturnValueOnce(ok({ trashId: 't-c' }))
    const c = await mount()
    fireEvent.click(rows(c)[0])
    fireEvent.click(rows(c)[2], { shiftKey: true })
    key(c, 'Delete')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Pindahkan 3 item ke Trash?')).toBeTruthy()
    fireEvent.click(within(dialog).getByText('Pindahkan ke Trash'))
    await settle()
    expect(fs.remove.mock.calls.map((a) => a[0])).toEqual(['/proj/a.txt', '/proj/b.txt', '/proj/c.txt'])
    expect(await screen.findByText('2 item dipindahkan ke Trash.')).toBeTruthy()
    expect(screen.getByText('1 dari 3 item gagal diproses.')).toBeTruthy()
    expect(screen.getByText(/Gagal menghapus “b.txt”\. Izin ditolak/)).toBeTruthy()

    fs.restore.mockReturnValue(ok({ path: '/proj/x' }))
    fireEvent.click(screen.getByText('Undo'))
    await settle()
    expect(fs.restore.mock.calls.map((a) => a[0])).toEqual(['t-a', 't-c'])
  })

  it('Undo ke tempat yang sudah terisi: tidak menimpa, pesan menyebut tempat asal terisi', async () => {
    fs.remove.mockReturnValue(ok({ trashId: 't-1' }))
    fs.restore.mockReturnValue(Promise.resolve({ ok: false, code: 'EEXIST', error: 'exists' }))
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'Delete')
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Pindahkan ke Trash'))
    await settle()
    fireEvent.click(await screen.findByText('Undo'))
    expect(await screen.findByText(/Gagal memulihkan “a.txt”\. Tempat asalnya sudah terisi/)).toBeTruthy()
  })
})

describe('Rename inline', () => {
  it('F2 membuka input berisi nama (basename terpilih); Enter memanggil rename tanpa overwrite', async () => {
    fs.rename.mockReturnValue(ok())
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'F2')
    const input = (await screen.findByLabelText('New name')) as HTMLInputElement
    expect(input.value).toBe('a.txt')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1])
    fireEvent.change(input, { target: { value: 'z.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(fs.rename).toHaveBeenCalledWith('/proj/a.txt', '/proj/z.txt', false)
    expect(events).toContainEqual({ kind: 'renamed', path: '/proj/z.txt', from: '/proj/a.txt', origin: 'local' })
    expect(screen.queryByLabelText('New name')).toBeNull()
  })

  it('nama sudah dipakai (EEXIST) tampil sebagai kalimat Indonesia, bukan kode', async () => {
    fs.rename.mockReturnValue(Promise.resolve({ ok: false, code: 'EEXIST', error: 'EEXIST: x' }))
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'F2')
    const input = await screen.findByLabelText('New name')
    fireEvent.change(input, { target: { value: 'b.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Gagal mengganti nama “a.txt”. Nama “b.txt” sudah dipakai di folder ini.')).toBeTruthy()
  })

  it('nama tak sah ditandai live dan Enter tidak memanggil rename; Escape membatalkan; nama sama = no-op', async () => {
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'F2')
    const input = await screen.findByLabelText('New name')
    fireEvent.change(input, { target: { value: 'a/b' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('garis miring')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(fs.rename).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('New name')).toBeNull()

    key(c, 'F2')
    fireEvent.keyDown(await screen.findByLabelText('New name'), { key: 'Enter' })
    await settle()
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('F2 dengan lebih dari satu seleksi tidak membuka input', async () => {
    const c = await mount()
    fireEvent.click(rows(c)[0])
    fireEvent.click(rows(c)[1], { shiftKey: true })
    key(c, 'F2')
    expect(screen.queryByLabelText('New name')).toBeNull()
  })
})

describe('Duplicate', () => {
  it('memilih nama bebas: "a copy 2.txt" bila "a copy.txt" sudah ada', async () => {
    fs.copy.mockReturnValue(ok())
    const c = await mount(['a.txt', 'a copy.txt'])
    fireEvent.click(rows(c)[0])
    fireEvent.contextMenu(rows(c)[0])
    fireEvent.click(await screen.findByText('Duplicate'))
    await settle()
    expect(fs.copy).toHaveBeenCalledWith('/proj/a.txt', '/proj/a copy 2.txt')
    expect(events).toContainEqual({ kind: 'created', path: '/proj/a copy 2.txt', origin: 'local' })
  })

  it('kelompok: tiap item disalin berurutan dan nama salinan tidak saling bentrok', async () => {
    fs.copy.mockReturnValue(ok())
    const c = await mount(['a.txt', 'b.txt'])
    key(c, 'a', { metaKey: true })
    fireEvent.contextMenu(rows(c)[0])
    fireEvent.click(await screen.findByText('Duplicate'))
    await settle()
    expect(fs.copy.mock.calls).toEqual([['/proj/a.txt', '/proj/a copy.txt'], ['/proj/b.txt', '/proj/b copy.txt']])
    expect(await screen.findByText('2 item diduplikat.')).toBeTruthy()
  })

  it('folder penuh/izin: EACCES jadi kalimat jelas', async () => {
    fs.copy.mockReturnValue(Promise.resolve({ ok: false, code: 'ENOSPC', error: 'x' }))
    const c = await mount()
    fireEvent.click(rows(c)[0])
    fireEvent.contextMenu(rows(c)[0])
    fireEvent.click(await screen.findByText('Duplicate'))
    expect(await screen.findByText('Gagal menduplikat “a.txt”. Ruang disk penuh.')).toBeTruthy()
  })
})

describe('menu', () => {
  it('menu konteks memuat Rename/Duplicate/Delete/Delete Permanently dengan shortcut', async () => {
    const c = await mount()
    fireEvent.click(rows(c)[0])
    fireEvent.contextMenu(rows(c)[0])
    for (const l of ['Rename…', 'Duplicate', 'Delete', 'Delete Permanently…', 'F2', 'Delete', '⇧Delete']) {
      expect((await screen.findAllByText(l)).length).toBeGreaterThan(0)
    }
  })

  it('seleksi ganda: Rename tidak ditawarkan', async () => {
    const c = await mount()
    fireEvent.click(rows(c)[0])
    fireEvent.click(rows(c)[1], { shiftKey: true })
    fireEvent.contextMenu(rows(c)[1])
    await screen.findByText('Duplicate')
    expect(screen.queryByText('Rename…')).toBeNull()
  })
})

describe('flag/capability mati', () => {
  it('mutate:false -> F2/Delete tidak melakukan apa pun, menu tanpa baris mutasi, tidak ada dialog', async () => {
    caps.mutate = false
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'F2')
    key(c, 'Delete')
    key(c, 'Delete', { shiftKey: true })
    await settle()
    expect(screen.queryByLabelText('New name')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.contextMenu(rows(c)[0])
    await screen.findByText('Refresh')
    for (const l of ['Rename…', 'Duplicate', 'Delete', 'Delete Permanently…']) expect(screen.queryByText(l)).toBeNull()
    expect(fs.remove).not.toHaveBeenCalled()
  })

  it('slot langsung: menu() kosong dan onKey() false untuk node yang belum terbukti aktif', () => {
    const ctx = { cwd: '/p', dir: '/p', entries: [], selection: ['a'], nodeId: 'never', refresh: vi.fn(), open: vi.fn(), startInput: vi.fn() }
    expect(mutateSlot.menu?.(ctx)).toEqual([])
    expect(mutateSlot.onKey?.({ key: 'Delete', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false } as never, ctx)).toBe(false)
    expect(ctx.startInput).not.toHaveBeenCalled()
  })

  it('tanpa window.confirm/prompt di alur mana pun', async () => {
    fs.remove.mockReturnValue(ok({ trashId: 't' }))
    const c = await mount()
    key(c, 'ArrowDown')
    key(c, 'Delete')
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Pindahkan ke Trash'))
    await settle()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(window.prompt).not.toHaveBeenCalled()
  })
})
