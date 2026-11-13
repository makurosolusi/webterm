/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SettingsItemScopeProvider } from '../settingsContext'
import { PROJECTS_FOLDER_TEXT, ProjectsFolderSetting } from './ProjectsFolderSetting'

// The real picker browses the server's disk; here it is one button that picks a fixed folder.
vi.mock('../FolderPicker', () => ({
  default: ({ onPick }: { onPick(p: string): void }) => <button type="button" onClick={() => onPick('/picked/folder')}>Pick this folder</button>,
}))

const BUILTIN = '/home/u/webterm/projects'
let checked: string[]

beforeEach(() => {
  checked = []
  vi.stubGlobal('fetch', vi.fn(async (raw: string, init?: RequestInit) => {
    const sub = new URL(raw, 'http://x').pathname.replace('/api/workspace-create', '')
    if (sub === '/defaults') return Response.json({ parent: BUILTIN, projectsFolder: BUILTIN, builtin: BUILTIN })
    if (sub === '/projects-folder/check') {
      const { path } = JSON.parse(String(init?.body)) as { path: string }
      checked.push(path)
      // test-only: mirrors the server rules (absolute, not in the data dir).
      if (!path.startsWith('/')) return Response.json({ error: 'bad_request', message: 'Use an absolute path, e.g. /Users/you/code.' }, { status: 400 })
      if (path.startsWith('/home/u/.webterm-server')) return Response.json({ error: 'bad_request', message: 'This is inside the webterm data folder.' }, { status: 400 })
      return Response.json({ path })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Default projects folder setting', () => {
  const box = () => screen.getByRole('combobox', { name: 'Default projects folder' }) as HTMLInputElement

  it('shows the built-in default as the box placeholder and offers it as a suggestion; no Save button', async () => {
    render(<ProjectsFolderSetting value="" onChange={vi.fn()} />)
    await waitFor(() => expect(box().placeholder).toBe(BUILTIN))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull() // commits like every combobox row
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(screen.getByRole('option').textContent).toBe(PROJECTS_FOLDER_TEXT.defaultLabel(BUILTIN))
  })

  it('a typed folder commits on Enter after the server check, saying "Checking folder…" meanwhile', async () => {
    const onChange = vi.fn()
    render(<ProjectsFolderSetting value="" onChange={onChange} />)
    fireEvent.change(box(), { target: { value: '/code/projects' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(screen.getByRole('status').textContent).toBe(PROJECTS_FOLDER_TEXT.checking)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/code/projects'))
    expect(checked).toEqual(['/code/projects'])
    expect(screen.queryByText(PROJECTS_FOLDER_TEXT.checking)).toBeNull()
  })

  it('Browse… picks a folder without typing, checked by the server first', async () => {
    const onChange = vi.fn()
    render(<ProjectsFolderSetting value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: PROJECTS_FOLDER_TEXT.browse }))
    fireEvent.click(screen.getByRole('button', { name: 'Pick this folder' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/picked/folder'))
    expect(checked).toEqual(['/picked/folder'])
    expect(screen.queryByRole('button', { name: 'Pick this folder' })).toBeNull() // the picker closed
  })

  it('rejects a relative path at once and one inside the data dir after the check, without saving', async () => {
    const onChange = vi.fn()
    render(<ProjectsFolderSetting value="" onChange={onChange} />)
    fireEvent.change(box(), { target: { value: 'code' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toBe(PROJECTS_FOLDER_TEXT.notAbsolute)
    expect(checked).toEqual([]) // never sent
    fireEvent.change(box(), { target: { value: '/home/u/.webterm-server/p' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('data folder'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Reset is the field\'s own Reset (one place), back to the default', async () => {
    const onChange = vi.fn()
    render(
      <SettingsItemScopeProvider settings={{ ...DEFAULT_SETTINGS, defaultProjectsFolder: '/code/projects' }} onChange={onChange}>
        <ProjectsFolderSetting value="/code/projects" onChange={vi.fn()} />
      </SettingsItemScopeProvider>,
    )
    expect(box().value).toBe('/code/projects')
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reset Setting: Default projects folder' }))
    expect(onChange).toHaveBeenCalledWith({ defaultProjectsFolder: '' })
  })
})
