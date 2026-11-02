/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FolderPicker from './FolderPicker'
import * as api from './api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const listing = (path: string, parent: string | null, dirs: string[]) => ({ path, parent, dirs })

describe('FolderPicker', () => {
  it('merender dialog VS Code dengan daftar subfolder berikon codicon', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue(listing('/home/u', '/home', ['src', 'docs']))
    render(<FolderPicker onPick={() => {}} onClose={() => {}} />)

    expect(screen.getByRole('dialog', { name: 'Choose a folder' })).toBeTruthy()
    await screen.findByText('src')
    expect(document.querySelectorAll('.fp-row .codicon-folder')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('📁')
  })

  it('klik subfolder masuk ke dalamnya, Go up naik, Select mengirim path aktif', async () => {
    const listDir = vi
      .spyOn(api, 'listDir')
      .mockResolvedValueOnce(listing('/home/u', '/home', ['src']))
      .mockResolvedValueOnce(listing('/home/u/src', '/home/u', []))
    const onPick = vi.fn()
    render(<FolderPicker initialPath="/home/u" onPick={onPick} onClose={() => {}} />)

    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('No subfolders')
    expect(listDir).toHaveBeenLastCalledWith('/home/u/src')

    fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }))
    expect(onPick).toHaveBeenCalledWith('/home/u/src')
  })

  it('Go up nonaktif di akar', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue(listing('/', null, []))
    render(<FolderPicker onPick={() => {}} onClose={() => {}} />)

    await screen.findByText('No subfolders')
    expect((screen.getByRole('button', { name: 'Go up' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('gagal memuat menampilkan pesan, bukan diam', async () => {
    vi.spyOn(api, 'listDir').mockRejectedValue(new Error('404'))
    render(<FolderPicker initialPath="/nope" onPick={() => {}} onClose={() => {}} />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('/nope'))
    expect(screen.getByRole('alert').textContent).toContain('404')
  })

  it('Cancel dan Escape menutup', async () => {
    vi.spyOn(api, 'listDir').mockResolvedValue(listing('/', null, []))
    const onClose = vi.fn()
    render(<FolderPicker onPick={() => {}} onClose={onClose} />)
    await screen.findByText('No subfolders')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
