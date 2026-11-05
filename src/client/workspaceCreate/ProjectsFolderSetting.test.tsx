/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsFolderSetting } from './ProjectsFolderSetting'

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
  it('shows the built-in default in use, saves a valid folder after the server check', async () => {
    const onChange = vi.fn()
    render(<ProjectsFolderSetting value="" onChange={onChange} />)
    expect((await screen.findByRole('status')).textContent).toBe(`In use: ${BUILTIN} (default)`)
    expect((screen.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Default projects folder'), { target: { value: '/code/projects' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/code/projects'))
    expect(checked).toEqual(['/code/projects'])
  })

  it('rejects a relative path and one inside the data dir without saving', async () => {
    const onChange = vi.fn()
    render(<ProjectsFolderSetting value="" onChange={onChange} />)
    const input = screen.getByLabelText('Default projects folder')
    fireEvent.change(input, { target: { value: 'code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('absolute path')
    fireEvent.change(input, { target: { value: '/home/u/.webterm-server/p' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('data folder'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Reset to default clears the setting', async () => {
    const onChange = vi.fn()
    render(<ProjectsFolderSetting value="/code/projects" onChange={onChange} />)
    expect((await screen.findByRole('status')).textContent).toBe('In use: /code/projects')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(onChange).toHaveBeenCalledWith('')
  })
})
