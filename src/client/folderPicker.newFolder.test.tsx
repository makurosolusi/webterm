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

async function openNewFolder(onPick = vi.fn(), onClose = vi.fn()) {
  const listDir = vi.spyOn(api, 'listDir').mockImplementation(async (p?: string) =>
    p === '/home/u/proj' ? listing('/home/u/proj', '/home/u', []) : listing('/home/u', '/home', ['src']))
  render(<FolderPicker initialPath="/home/u" onPick={onPick} onClose={onClose} />)
  await screen.findByText('src')
  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  const input = screen.getByRole('textbox', { name: 'New folder name' }) as HTMLInputElement
  return { listDir, input, onPick, onClose }
}

describe('FolderPicker New Folder', () => {
  it('shows a focused name input at the top of the list', async () => {
    const { input } = await openNewFolder()
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('.fp-list')?.firstElementChild?.contains(input)).toBe(true)
    expect(document.querySelector('.codicon-new-folder')).toBeTruthy()
  })

  it('Enter creates through the API, enters the new folder, and Select returns its path', async () => {
    const makeFolder = vi.spyOn(api, 'makeFolder').mockResolvedValue({ path: '/home/u/proj' })
    const { listDir, input, onPick } = await openNewFolder()
    fireEvent.change(input, { target: { value: 'proj' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(makeFolder).toHaveBeenCalledWith('/home/u', 'proj')
    await screen.findByText('No subfolders')
    expect(listDir).toHaveBeenLastCalledWith('/home/u/proj')
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Select this folder' }))
    expect(onPick).toHaveBeenCalledWith('/home/u/proj')
  })

  it('Escape cancels the row without closing the dialog', async () => {
    const makeFolder = vi.spyOn(api, 'makeFolder')
    const { input, onClose } = await openNewFolder()
    fireEvent.change(input, { target: { value: 'half' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(makeFolder).not.toHaveBeenCalled()
  })

  it('blur with an empty name cancels; blur with a name keeps the row', async () => {
    const { input } = await openNewFolder()
    fireEvent.change(input, { target: { value: 'keep' } })
    fireEvent.blur(input)
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toBeTruthy()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).toBeNull()
  })

  it.each([
    ['a/b', '"/"'],
    ['..', '".."'],
    [' lead', 'space'],
    ['x'.repeat(256), '255 bytes'],
  ])('blocks the invalid name %j client-side', async (name, hint) => {
    const makeFolder = vi.spyOn(api, 'makeFolder')
    const { input } = await openNewFolder()
    fireEvent.change(input, { target: { value: name } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByRole('alert').textContent).toContain(hint)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(makeFolder).not.toHaveBeenCalled()
  })

  it('shows the server message (already exists, permission denied) and keeps the row open', async () => {
    const err = Object.assign(new Error('POST /api/fs -> 409'), { status: 409, serverMessage: '"src" already exists in /home/u.' })
    vi.spyOn(api, 'makeFolder').mockRejectedValue(err)
    const { input } = await openNewFolder()
    fireEvent.change(input, { target: { value: 'src' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('"src" already exists in /home/u.'))
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toBeTruthy()
  })

  it('a failure without a server message still says what failed', async () => {
    vi.spyOn(api, 'makeFolder').mockRejectedValue(new Error('POST /api/fs -> 500'))
    const { input } = await openNewFolder()
    fireEvent.change(input, { target: { value: 'boom' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Cannot create "boom": POST /api/fs -> 500'))
  })

  it('shows Creating while the request is in flight', async () => {
    let resolve!: (v: { path: string }) => void
    vi.spyOn(api, 'makeFolder').mockReturnValue(new Promise((r) => { resolve = r }))
    const { input } = await openNewFolder()
    fireEvent.change(input, { target: { value: 'proj' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('Creating…')).toBeTruthy()
    expect(input.disabled).toBe(true)
    resolve({ path: '/home/u/proj' })
    await screen.findByText('No subfolders')
  })
})
