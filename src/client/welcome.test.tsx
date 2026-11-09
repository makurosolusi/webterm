/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Welcome from './Welcome'

afterEach(cleanup)

const noop = () => {}

describe('Welcome', () => {
  it('menampilkan brand, tagline, dan empat kartu aksi', () => {
    render(<Welcome onNewProject={noop} onCreateEmpty={noop} />)
    expect(screen.getByText('webterm')).toBeTruthy()
    expect(screen.getByText('A canvas of terminals. Start a project to begin.')).toBeTruthy()
    for (const label of ['New project', 'Open folder…', 'Clone repo…', 'Connect over SSH…']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('klik "Open folder…" memanggil onNewProject (pemilih folder)', () => {
    const onNewProject = vi.fn()
    render(<Welcome onNewProject={onNewProject} onCreateEmpty={noop} />)
    fireEvent.click(screen.getByText('Open folder…'))
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })

  // New project / Clone membuka dialognya: lihat workspaceCreate/workspaceCreate.test.tsx.
  it('hanya kartu SSH yang disabled (belum ada backend webterm)', () => {
    render(<Welcome onNewProject={noop} onCreateEmpty={noop} />)
    expect(screen.getByText('Clone repo…').closest('button')?.disabled).toBe(false)
    expect(screen.getByText('Connect over SSH…').closest('button')?.disabled).toBe(true)
    expect(screen.getByText('New project').closest('button')?.disabled).toBe(false)
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
