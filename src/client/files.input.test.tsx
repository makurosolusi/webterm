/** @vitest-environment jsdom */
// Fase 2 shell FilesNode (WS-FM-03): input nama inline pengganti window.prompt — Enter/Esc/validasi.
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow, type ReactFlowInstance } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fs = vi.hoisted(() => ({
  list: vi.fn(), mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
}))
// Slot menanyakan kemampuan server; tes shell berjalan dengan semua fitur mati.
vi.mock('./fsClient', async () => ({ ...fs, ...(await import('./filesCaps.fixture')).capsMock() }))

import FilesNode from './FilesNode'

let rf: ReactFlowInstance
const Probe = () => { rf = useReactFlow(); return null }
const tree = () => (
  <ReactFlowProvider defaultNodes={[]} defaultEdges={[]}>
    <Probe />
    <FilesNode {...({ id: 'f1', data: { dirPath: '/proj', title: 't' }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
  </ReactFlowProvider>
)
const rows = (c: HTMLElement) => [...c.querySelectorAll('.files-row')]
const foot = (c: HTMLElement) => c.querySelector('.files-foot')?.textContent

async function mount() {
  fs.list.mockResolvedValue([{ name: 'a.txt', dir: false }])
  fs.mkdir.mockResolvedValue(true)
  const r = render(tree())
  await waitFor(() => expect(rows(r.container)).toHaveLength(1))
  return r.container
}
async function startNew(c: HTMLElement, label: string) {
  fireEvent.contextMenu(c.querySelector('.files-list') as HTMLElement)
  fireEvent.click(await screen.findByText(label))
  return screen.findByRole('textbox', { name: /new (file|folder) name/i }) as Promise<HTMLInputElement>
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.values(fs).forEach((m) => m.mockReset()) })

describe('input nama inline', () => {
  it('New File… membuka input fokus; window.prompt tidak pernah dipanggil', async () => {
    const prompt = vi.spyOn(window, 'prompt')
    const c = await mount()
    const input = await startNew(c, 'New File…')
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-label')).toBe('New file name')
    fireEvent.change(input, { target: { value: 'n.txt' } })
    fs.create.mockResolvedValue({ ok: true })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(fs.create).toHaveBeenCalledWith('/proj/n.txt'))
    expect(prompt).not.toHaveBeenCalled()
    expect(c.querySelector('.files-input')).toBeNull()
  })

  it('New Folder… memberi label folder dan memakai mkdirChecked', async () => {
    const c = await mount()
    const input = await startNew(c, 'New Folder…')
    expect(input.getAttribute('aria-label')).toBe('New folder name')
    fs.mkdirChecked.mockResolvedValue({ ok: true, created: true })
    fireEvent.change(input, { target: { value: 'src/deep' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(fs.mkdirChecked).toHaveBeenCalledWith('/proj/src/deep'))
    expect(fs.mkdir).toHaveBeenCalledWith('/proj/src')
  })

  it('Escape membatalkan tanpa menyentuh filesystem dan mengembalikan fokus ke daftar', async () => {
    const c = await mount()
    const input = await startNew(c, 'New File…')
    fireEvent.change(input, { target: { value: 'x.txt' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(c.querySelector('.files-input')).toBeNull()
    expect(document.activeElement).toBe(c.querySelector('.files-list'))
    expect(fs.create).not.toHaveBeenCalled()
  })

  it('nama tak valid ditandai langsung dan Enter tidak memasang; kosong juga tidak', async () => {
    const c = await mount()
    const input = await startNew(c, 'New File…')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '../escape' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect((await screen.findByRole('alert')).textContent).toBe('That name is not allowed here.')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '/abs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(fs.create).not.toHaveBeenCalled()
    expect(c.querySelector('.files-input')).not.toBeNull()
    fireEvent.change(input, { target: { value: 'ok.txt' } })
    expect(input.getAttribute('aria-invalid')).toBe('false')
  })

  it('tombol di input tidak bocor ke list/canvas (Backspace menghapus node di React Flow)', async () => {
    const c = await mount()
    const input = await startNew(c, 'New File…')
    const leaked = vi.fn()
    document.addEventListener('keydown', leaked)
    for (const k of ['Backspace', 'Delete', 'ArrowLeft', 'a']) fireEvent.keyDown(input, { key: k })
    document.removeEventListener('keydown', leaked)
    expect(leaked).not.toHaveBeenCalled()
    // ArrowLeft di input tidak boleh menaikkan folder (handler list di atasnya).
    expect(c.querySelector('.files-input')).not.toBeNull()
  })

  it('blur membatalkan input', async () => {
    const c = await mount()
    const input = await startNew(c, 'New File…')
    fireEvent.blur(input)
    expect(c.querySelector('.files-input')).toBeNull()
  })

  it('nama tak diizinkan dari lapisan create tampil sebagai notice, bukan crash', async () => {
    const c = await mount()
    const input = await startNew(c, 'New File…')
    fs.create.mockResolvedValue({ ok: false, code: 'EACCES', error: 'denied' })
    fireEvent.change(input, { target: { value: 'z.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(foot(c)).toContain('denied'))
    expect(rf.getNodes().filter((n) => n.type === 'editor')).toHaveLength(0)
  })
})
