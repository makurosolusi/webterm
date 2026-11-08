/** @vitest-environment jsdom */
// Mini-Explorer: ikon codicon per jenis entry (bukan svg), welcome view folder kosong. fsClient
// dipalsukan; yang diuji DOM yang dirender node.
import type { ComponentProps } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'

const list = vi.hoisted(() => vi.fn())
vi.mock('./fsClient', async () => ({ list, mkdir: vi.fn(), write: vi.fn(), stat: vi.fn(), listV2: vi.fn(), ...(await import('./filesCaps.fixture')).capsMock() }))

import FilesNode from './FilesNode'

afterEach(() => { cleanup(); list.mockReset() })

const mount = (dirPath: string) =>
  render(
    <ReactFlowProvider>
      <FilesNode {...({ id: 'f1', data: { dirPath, title: 't' }, selected: false } as unknown as ComponentProps<typeof FilesNode>)} />
    </ReactFlowProvider>,
  )

describe('FilesNode — tampilan Explorer', () => {
  it('merender ikon codicon per entry dan tanpa svg di baris', async () => {
    list.mockResolvedValue([
      { name: 'src', dir: true },
      { name: 'package.json', dir: false },
      { name: 'notes.md', dir: false },
    ])
    const { container } = mount('/proj')
    await waitFor(() => expect(container.querySelectorAll('.files-row')).toHaveLength(3))
    const icons = [...container.querySelectorAll('.files-row .files-icon')].map((e) => e.className)
    expect(icons).toEqual([
      'codicon codicon-folder files-icon',
      'codicon codicon-json files-icon',
      'codicon codicon-markdown files-icon',
    ])
    expect(container.querySelector('.files-row svg')).toBeNull()
    // Double-click renames a row; without `nopan` React Flow also zooms the canvas in on that dblclick.
    expect(container.querySelector('.files-list')?.classList.contains('nopan')).toBe(true)
  })

  it('folder kosong menampilkan welcome view dengan tombol New File…', async () => {
    list.mockImplementation((p: string) => Promise.resolve(p === '/proj' ? [] : [{ name: 'proj', dir: true }]))
    const { container } = mount('/proj')
    await waitFor(() => expect(container.querySelector('.files-welcome')).not.toBeNull())
    expect(container.querySelector('.files-welcome p')?.textContent).toBe('This folder is empty.')
    expect(container.querySelector('.files-welcome vscode-button')?.textContent).toBe('New File…')
  })
})
