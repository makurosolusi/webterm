/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Welcome from './Welcome'
import { openSetup } from './setup/setup.open'
import type { SetupState } from '../shared/settings'

vi.mock('./setup/setup.open', () => ({ openSetup: vi.fn() }))

afterEach(cleanup)

const noop = () => {}

describe('Welcome', () => {
  it('menampilkan brand, tagline, dan tiga kartu aksi tanpa entri SSH mati', () => {
    render(<Welcome onNewProject={noop} onCreateEmpty={noop} />)
    expect(screen.getByText('webterm')).toBeTruthy()
    expect(screen.getByText('A canvas of terminals. Start a project to begin.')).toBeTruthy()
    for (const label of ['New project', 'Open folder…', 'Clone repo…']) {
      expect(screen.getByText(label).closest('button')?.disabled).toBe(false)
    }
    expect(screen.queryByText('Connect over SSH…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create empty' })).toBeTruthy()
  })

  it('has one h1, a wrapping tagline, 44px Start actions and a labelled empty-workspace form', () => {
    const css = readFileSync(join(__dirname, 'welcome.css'), 'utf8')
    const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)))
    render(<Welcome onNewProject={noop} onCreateEmpty={noop} />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(rule('.welcome__subtitle')).not.toMatch(/nowrap|ellipsis|overflow: hidden/)
    expect(rule('.welcome__link--action')).toContain('min-height: 44px')
    expect(screen.getByLabelText('Or create an empty workspace').tagName).toBe('INPUT')
  })

  it('validates the empty-workspace name inline and submits with Enter', () => {
    const onCreateEmpty = vi.fn()
    render(<Welcome onNewProject={noop} onCreateEmpty={onCreateEmpty} />)
    const input = screen.getByLabelText('Or create an empty workspace')
    fireEvent.click(screen.getByRole('button', { name: 'Create empty' }))
    expect(screen.getByTestId('welcome-name-error').textContent).toBe('Enter a workspace name.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(onCreateEmpty).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' scratch ' } })
    fireEvent.submit(input.closest('form')!)
    expect(onCreateEmpty).toHaveBeenCalledWith('scratch')
    expect(screen.queryByTestId('welcome-name-error')).toBeNull()
  })

  it('klik "Open folder…" memanggil onNewProject (pemilih folder)', () => {
    const onNewProject = vi.fn()
    render(<Welcome onNewProject={onNewProject} onCreateEmpty={noop} />)
    fireEvent.click(screen.getByText('Open folder…'))
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })

  // New project / Clone membuka dialognya: lihat workspaceCreate/workspaceCreate.test.tsx.
  describe('Finish setup card', () => {
    const mixed: SetupState = { completedAt: null, steps: { claude: 'done', browser: 'skipped' } } // test-only

    it('lists every step with Done / Skipped / Not started, the wizard words and counts done steps', () => {
      render(<Welcome onNewProject={noop} onCreateEmpty={noop} setup={mixed} />)
      expect(screen.getByRole('heading', { name: 'Finish setup · 1 of 5' })).toBeTruthy()
      const row = (label: string) => screen.getByText(label).closest('button')!.textContent
      expect(row('Claude')).toBe('ClaudeDone')
      expect(row('Browser')).toBe('BrowserSkipped')
      expect(row('Central Agent')).toBe('Central AgentNot started')
      expect(row('Basics')).toBe('BasicsNot started')
    })

    it('a row opens setup at that step; the button resumes', () => {
      vi.mocked(openSetup).mockClear()
      render(<Welcome onNewProject={noop} onCreateEmpty={noop} setup={mixed} />)
      fireEvent.click(screen.getByText('Central Agent'))
      expect(openSetup).toHaveBeenLastCalledWith('central')
      fireEvent.click(screen.getByRole('button', { name: 'Set up webterm' }))
      expect(openSetup).toHaveBeenLastCalledWith()
    })

    it('is hidden once setup is completed, and while settings are not hydrated', () => {
      render(<Welcome onNewProject={noop} onCreateEmpty={noop} setup={{ completedAt: 1, steps: {} }} />)
      expect(screen.queryByText(/Finish setup/)).toBeNull()
      cleanup()
      render(<Welcome onNewProject={noop} onCreateEmpty={noop} />)
      expect(screen.queryByText(/Finish setup/)).toBeNull()
    })
  })

  describe('Recently closed', () => {
    const closedSessions = [
      { node: { id: 'n1', kind: 'terminal' as const, x: 0, y: 0, title: 'shell' }, workspaceId: 'w1', workspaceName: 'proj', closedAt: Date.now() },
    ]
    const open = () => {
      const onReopen = vi.fn()
      render(<Welcome onNewProject={noop} onCreateEmpty={noop} closedSessions={closedSessions} onReopen={onReopen} />)
      expect(screen.getByText('Recently closed')).toBeTruthy()
      fireEvent.click(screen.getByText('proj'))
      // A row click asks first; no workspace is open, so the copy says webterm switches.
      expect(screen.getByText('Reopen “shell”?')).toBeTruthy()
      expect(screen.getByText(/webterm switches to that workspace/)).toBeTruthy()
      expect(onReopen).not.toHaveBeenCalled()
      return onReopen
    }

    it('reopens the session once the confirm says Reopen', async () => {
      const onReopen = open()
      fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
      await waitFor(() => expect(onReopen).toHaveBeenCalledWith('n1'))
    })

    it('does not reopen when the confirm is cancelled', async () => {
      const onReopen = open()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await Promise.resolve()
      expect(onReopen).not.toHaveBeenCalled()
    })
  })
})
