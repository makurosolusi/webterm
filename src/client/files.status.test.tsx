/** @vitest-environment jsdom */
// Fase 2 shell FilesNode (WS-FM-03): 401 vs tak terjangkau + Retry, dan opsi tampilan (viewOpts).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useNodes, useReactFlow, type ReactFlowInstance } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewOpts } from '../shared/workspace'
import './vscode/test-setup'

const fs = vi.hoisted(() => ({
  list: vi.fn(), mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
}))
vi.mock('./fsClient', () => fs)

import FilesNode from './FilesNode'
import { UNAUTHORIZED, UNREACHABLE } from './FilesList'

let rf: ReactFlowInstance
/** Meneruskan data node yang hidup (updateNodeData terlihat), seperti canvas sungguhan. */
function Live() {
  rf = useReactFlow()
  const n = useNodes().find((x) => x.id === 'f1')
  return n ? <FilesNode {...(({ id: 'f1', data: n.data, selected: false }) as never as React.ComponentProps<typeof FilesNode>)} /> : null
}
const tree = (dirPath: string, viewOpts?: ViewOpts) => (
  <ReactFlowProvider defaultNodes={[{ id: 'f1', type: 'files', position: { x: 0, y: 0 }, data: { dirPath, title: 't', viewOpts } }]} defaultEdges={[]}>
    <Live />
  </ReactFlowProvider>
)
const names = (c: HTMLElement) => [...c.querySelectorAll('.files-name')].map((n) => n.textContent)
const alertText = async () => (await screen.findByRole('alert')).textContent

afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.values(fs).forEach((m) => m.mockReset()) })

describe('listing kosong: 401 dibedakan dari tak terjangkau', () => {
  const dead = () => fs.list.mockResolvedValue([])

  it('401 → pesan akses ditolak, bukan "Could not reach"', async () => {
    dead()
    fs.stat.mockResolvedValue({ ok: false, code: 'EIO', error: 'HTTP 401' })
    render(tree('/proj'))
    expect(await alertText()).toContain(UNAUTHORIZED)
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
  })

  it('kegagalan lain (mis. 502) tetap "Could not reach"', async () => {
    dead()
    fs.stat.mockResolvedValue({ ok: false, code: 'EIO', error: 'HTTP 502' })
    render(tree('/proj'))
    expect(await alertText()).toContain(UNREACHABLE)
  })

  it('tombol Retry memuat ulang listing', async () => {
    dead()
    fs.stat.mockResolvedValue({ ok: false, code: 'EIO', error: 'HTTP 502' })
    const { container } = render(tree('/proj'))
    await alertText()
    const before = fs.list.mock.calls.filter(([p]) => p === '/proj').length
    fs.list.mockImplementation((p: string) => Promise.resolve(p === '/proj' ? [{ name: 'back.txt', dir: false }] : []))
    fireEvent.click(container.querySelector('.files-empty--error vscode-button') as HTMLElement)
    await waitFor(() => expect(names(container)).toEqual(['back.txt']))
    expect(fs.list.mock.calls.filter(([p]) => p === '/proj').length).toBeGreaterThan(before)
  })

  it('folder yang memang kosong tidak memicu probe stat', async () => {
    fs.list.mockImplementation((p: string) => Promise.resolve(p === '/proj' ? [] : [{ name: 'proj', dir: true }]))
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(container.querySelector('.files-welcome')).not.toBeNull())
    expect(fs.stat).not.toHaveBeenCalled()
  })
})

describe('viewOpts', () => {
  const dir = [
    { name: 'src', dir: true, ignored: false },
    { name: '.env', dir: false, ignored: false },
    { name: 'a.txt', dir: false, ignored: false },
    { name: 'b.txt', dir: false, ignored: false },
  ]
  const toolbarBtn = (c: HTMLElement, label: string) => c.querySelector(`[aria-label="${label}"]`) as HTMLElement

  it('default menampilkan dotfile; toggle menyembunyikan dan mempersist ke node', async () => {
    fs.list.mockResolvedValue(dir)
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(names(container)).toEqual(['src', '.env', 'a.txt', 'b.txt']))
    fireEvent.click(toolbarBtn(container, 'Hide hidden files'))
    await waitFor(() => expect(names(container)).toEqual(['src', 'a.txt', 'b.txt']))
    expect(rf.getNode('f1')?.data.viewOpts).toEqual({ hidden: true, sortKey: 'name', sortDir: 'asc' })
    expect(toolbarBtn(container, 'Hide hidden files').getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.files-foot')?.textContent).toBe('3 of 4')
  })

  it('viewOpts tersimpan dipakai saat node dipasang', async () => {
    fs.list.mockResolvedValue(dir)
    const { container } = render(tree('/proj', { hidden: true, sortKey: 'name', sortDir: 'desc' }))
    await waitFor(() => expect(names(container)).toEqual(['src', 'b.txt', 'a.txt']))
  })

  it('urut ukuran memakai listV2 dan dipersist; urutan nama tidak memanggil listV2', async () => {
    fs.list.mockResolvedValue(dir)
    fs.listV2.mockResolvedValue({
      ok: true, truncated: false,
      entries: [
        { name: 'src', dir: true, ignored: false },
        { name: 'a.txt', dir: false, ignored: false, size: 900 },
        { name: 'b.txt', dir: false, ignored: false, size: 10 },
      ],
    })
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(names(container)).toHaveLength(4))
    expect(fs.listV2).not.toHaveBeenCalled()
    fireEvent.click(toolbarBtn(container, 'Sort'))
    fireEvent.click(await screen.findByText('Sort by Size'))
    await waitFor(() => expect(names(container)).toEqual(['src', 'b.txt', 'a.txt']))
    expect(fs.listV2).toHaveBeenCalledWith('/proj')
    expect(rf.getNode('f1')?.data.viewOpts).toMatchObject({ sortKey: 'size', sortDir: 'asc' })
  })

  it('listV2 gagal jatuh ke list biasa (daftar tetap tampil)', async () => {
    fs.list.mockResolvedValue(dir)
    fs.listV2.mockResolvedValue({ ok: false, code: 'EIO', error: 'x' })
    const { container } = render(tree('/proj', { hidden: false, sortKey: 'size', sortDir: 'desc' }))
    await waitFor(() => expect(names(container).length).toBeGreaterThan(0))
  })
})
