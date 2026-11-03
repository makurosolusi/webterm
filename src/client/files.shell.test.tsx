/** @vitest-environment jsdom */
// Fase 1 shell FilesNode (WS-FM-03): create eksklusif + pesan FsFail (G-01), race loading (G-04),
// seleksi per nama NFC (G-17). fsClient dipalsukan; yang diuji DOM yang dirender node.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider, useReactFlow, type ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const fs = vi.hoisted(() => ({
  list: vi.fn(), mkdir: vi.fn(), mkdirChecked: vi.fn(), create: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(),
}))
vi.mock('./fsClient', () => fs)

import FilesNode from './FilesNode'
import { indexOfName, nfcName } from './filesSelection'

let rf: ReactFlowInstance
const Probe = () => { rf = useReactFlow(); return null }

const tree = (dirPath: string) => (
  <ReactFlowProvider defaultNodes={[]} defaultEdges={[]}>
    <Probe />
    <FilesNode {...({ id: 'f1', data: { dirPath, title: 't' }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
  </ReactFlowProvider>
)
const rows = (c: HTMLElement) => [...c.querySelectorAll('.files-row')] as HTMLElement[]
const foot = (c: HTMLElement) => c.querySelector('.files-foot')?.textContent
/** Kuras effect pasif: handler baris dipasang native di useEffect, setelah DOM baris muncul. */
const settle = () => act(async () => {})
const A_TXT = [{ name: 'a.txt', dir: false }]

/** Buka menu konteks daftar → klik item → ketik nama di input inline + Enter (pengganti window.prompt). */
async function pick(c: HTMLElement, label: string, name: string) {
  fireEvent.contextMenu(c.querySelector('.files-list') as HTMLElement)
  fireEvent.click(await screen.findByText(label))
  const input = await screen.findByRole('textbox', { name: /new (file|folder) name/i })
  fireEvent.change(input, { target: { value: name } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

beforeEach(() => { fs.mkdir.mockResolvedValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.values(fs).forEach((m) => m.mockReset()) })

describe('createEntry — create eksklusif (G-01)', () => {
  it('nama sudah ada: notice "Sudah ada: <nama>", tidak menimpa, tidak membuka editor', async () => {
    fs.list.mockResolvedValue(A_TXT)
    fs.create.mockResolvedValue({ ok: false, code: 'EEXIST', error: 'EEXIST: file exists' })
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(rows(container)).toHaveLength(1))
    await pick(container, 'New File…', 'a.txt')
    await waitFor(() => expect(foot(container)).toBe('Sudah ada: a.txt'))
    expect(fs.create).toHaveBeenCalledWith('/proj/a.txt')
    expect(fs.write).not.toHaveBeenCalled()
    expect(rf.getNodes().filter((n) => n.type === 'editor')).toHaveLength(0)
  })

  it('sukses: daftar dimuat ulang dan file baru dibuka di editor', async () => {
    fs.list.mockResolvedValue(A_TXT)
    fs.create.mockResolvedValue({ ok: true })
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(rows(container)).toHaveLength(1))
    await pick(container, 'New File…', 'new.txt')
    await waitFor(() => expect(rf.getNodes().some((n) => n.type === 'editor' && n.data.filePath === '/proj/new.txt')).toBe(true))
    await waitFor(() => expect(fs.list.mock.calls.filter(([p]) => p === '/proj').length).toBeGreaterThan(1))
  })

  it('error lain dari FsFail ditampilkan apa adanya, bukan pesan generik', async () => {
    fs.list.mockResolvedValue(A_TXT)
    fs.create.mockResolvedValue({ ok: false, code: 'EACCES', error: 'permission denied' })
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(rows(container)).toHaveLength(1))
    await pick(container, 'New File…', 'x.txt')
    await waitFor(() => expect(foot(container)).toContain('permission denied'))
  })

  it('folder: mkdir memakai mkdirChecked; created:false jadi notice "Sudah ada"', async () => {
    fs.list.mockResolvedValue(A_TXT)
    fs.mkdirChecked.mockResolvedValue({ ok: true, created: false })
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(rows(container)).toHaveLength(1))
    await pick(container, 'New Folder…', 'sub')
    await waitFor(() => expect(foot(container)).toBe('Sudah ada: sub'))
    expect(fs.mkdirChecked).toHaveBeenCalledWith('/proj/sub')
    expect(fs.write).not.toHaveBeenCalled()
  })
})

describe('race loading (G-04)', () => {
  it('berpindah folder: baris folder lama hilang selama loading, tak bisa dibuka dengan path salah', async () => {
    let finishB!: (v: unknown) => void
    fs.list.mockImplementation((p: string) =>
      p === '/a' ? Promise.resolve([{ name: 'old.txt', dir: false }])
        : p === '/b' ? new Promise((r) => { finishB = r }) : Promise.resolve([]))
    const { container, rerender } = render(tree('/a'))
    await waitFor(() => expect(rows(container)).toHaveLength(1))
    const stale = rows(container)[0]

    rerender(tree('/b'))
    await waitFor(() => expect(rows(container)).toHaveLength(0))
    fireEvent.doubleClick(stale)
    expect(rf.getNodes().filter((n) => n.type === 'editor')).toHaveLength(0)

    await act(async () => { finishB([{ name: 'new.txt', dir: false }]) })
    await waitFor(() => expect(rows(container).map((r) => r.textContent)).toEqual(['new.txt']))
  })
})

describe('seleksi per nama (G-17)', () => {
  const refresh = async () => {
    fireEvent.click(document.querySelector('[data-title="More Actions…"]') as HTMLElement)
    fireEvent.click(await screen.findByText('Refresh view'))
  }

  it('seleksi bertahan setelah refresh walau urutan/indeks berubah', async () => {
    fs.list.mockResolvedValueOnce([{ name: 'a', dir: false }, { name: 'b', dir: false }])
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(rows(container)).toHaveLength(2))
    await settle()
    fireEvent.click(rows(container)[1])
    expect(container.querySelector('.files-row--sel')?.textContent).toBe('b')

    fs.list.mockResolvedValue([{ name: '0', dir: false }, { name: 'a', dir: false }, { name: 'b', dir: false }])
    await refresh()
    await waitFor(() => expect(rows(container)).toHaveLength(3))
    expect(container.querySelector('.files-row--sel')?.textContent).toBe('b')
  })

  it('NFD vs NFC dianggap nama yang sama', async () => {
    fs.list.mockResolvedValueOnce([{ name: 'é.txt', dir: false }])
    const { container } = render(tree('/proj'))
    await waitFor(() => expect(rows(container)).toHaveLength(1))
    await settle()
    fireEvent.click(rows(container)[0])
    fs.list.mockResolvedValue([{ name: 'é.txt', dir: false }])
    await refresh()
    await waitFor(() => expect(rows(container)[0].textContent).toBe('é.txt'))
    expect(container.querySelector('.files-row--sel')).not.toBeNull()
  })
})

describe('filesSelection', () => {
  it('indexOfName mencocokkan NFC dan -1 untuk null/tak ada', () => {
    const es = [{ name: 'x', dir: false, ignored: false }, { name: 'é', dir: false, ignored: false }]
    expect(indexOfName(es, nfcName('é'))).toBe(1)
    expect(indexOfName(es, null)).toBe(-1)
    expect(indexOfName(es, 'zzz')).toBe(-1)
  })
})
