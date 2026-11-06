/** @vitest-environment jsdom */
// Create-workspace dialog: plain create closes only once the workspace exists, else shows the error inline; "New branch (worktree)" prefills the repo from the
// active workspace, creates the worktree, opens the workspace at the worktree path and shows the
// setup log. Plus the delete-time worktree offer and the tab badge. API is faked.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { CreatedWorktree, WorktreeStatus } from './workspaceWorktree.api'

const api = vi.hoisted(() => ({ getActive: vi.fn(), getWorkspace: vi.fn() }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), ...api }))

import { WorkspaceDialog } from './Dock.workspaceDialog'
import { offerRemoveWorktree, removeWorktreeMessage } from './workspaceWorktree.api'
import { WorkspaceWorktreeBadge } from './WorkspaceWorktreeBadge'

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const CREATED: CreatedWorktree = {
  path: '/data/worktrees/proj/add-login', branch: 'add-login', base: 'main', primary: '/repo',
  includes: { copied: ['.env'], skipped: [] },
  setup: { source: 'orca.yaml', ran: true, ok: true, timedOut: false, exitCode: 0, output: 'installed deps' },
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function renderDialog() {
  const onCreateWorkspace = vi.fn()
  const onOpenChange = vi.fn()
  render(<WorkspaceDialog open onOpenChange={onOpenChange} onCreateWorkspace={onCreateWorkspace} onBrowse={vi.fn()} />)
  return { onCreateWorkspace, onOpenChange }
}

describe('WorkspaceDialog', () => {
  it('plain create passes name + cwd and closes once the workspace exists', async () => {
    const { onCreateWorkspace, onOpenChange } = renderDialog()
    let created!: () => void
    onCreateWorkspace.mockReturnValue(new Promise<void>((r) => { created = r }))
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'Docs' } })
    fireEvent.change(screen.getByPlaceholderText('cwd (optional)'), { target: { value: '/repo' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreateWorkspace).toHaveBeenCalledWith('Docs', '/repo')
    expect(screen.getByText('Creating…')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
    created()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('plain create failure keeps the dialog open with the server message inline', async () => {
    const { onCreateWorkspace, onOpenChange } = renderDialog()
    onCreateWorkspace.mockRejectedValue(Object.assign(new Error('POST /api/workspaces -> 400: cwd does not exist'), {
      status: 400, serverMessage: 'cwd does not exist',
    }))
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'Docs' } })
    fireEvent.change(screen.getByPlaceholderText('cwd (optional)'), { target: { value: '/nope' } })
    fireEvent.click(screen.getByText('Create'))
    expect((await screen.findByRole('alert')).textContent).toBe('cwd does not exist')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('name') as HTMLInputElement).value).toBe('Docs') // input kept for a fix
    expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Create stays disabled while the name is blank', () => {
    const { onCreateWorkspace } = renderDialog()
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: '   ' } })
    expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByPlaceholderText('name'), { key: 'Enter' })
    expect(onCreateWorkspace).not.toHaveBeenCalled()
  })

  it('worktree create: repo from active workspace, workspace cwd = worktree, setup log shown', async () => {
    api.getActive.mockResolvedValue('w1')
    api.getWorkspace.mockResolvedValue({ id: 'w1', cwd: '/repo' })
    const fetchMock = vi.fn(async () => jsonRes(CREATED, 201))
    vi.stubGlobal('fetch', fetchMock)
    const { onCreateWorkspace } = renderDialog()
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'Add login' } })
    fireEvent.click(screen.getByLabelText('New branch (worktree)'))
    await waitFor(() => expect((screen.getByPlaceholderText('repository folder') as HTMLInputElement).value).toBe('/repo'))
    fireEvent.click(screen.getByText('Create'))
    await screen.findByText('installed deps')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/workspace-worktree/create')
    expect(JSON.parse(String(init.body))).toEqual({ repo: '/repo', title: 'Add login', runSetup: true })
    expect(onCreateWorkspace).toHaveBeenCalledWith('Add login', CREATED.path)
    expect(screen.getByText('Setup from orca.yaml finished.')).toBeTruthy()
  })

  it('worktree create failure shows the server reason and creates no workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ error: 'invalid_repo', message: '/x is not inside a git repository' }, 400)))
    const { onCreateWorkspace } = renderDialog()
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'X' } })
    fireEvent.change(screen.getByPlaceholderText('cwd (optional)'), { target: { value: '/x' } })
    fireEvent.click(screen.getByLabelText('New branch (worktree)'))
    fireEvent.click(screen.getByText('Create'))
    expect((await screen.findByRole('alert')).textContent).toContain('not inside a git repository')
    expect(onCreateWorkspace).not.toHaveBeenCalled()
  })
})

describe('offerRemoveWorktree', () => {
  const dirty: WorktreeStatus = { managed: true, path: '/wt', branch: 'feat', dirty: ['?? a'], dirtyCount: 1, unpushed: 2 }

  it('warns about uncommitted + unpushed work, keeps the branch, and sends confirm only after yes', async () => {
    const fetchMock = vi.fn(async (url: string) => jsonRes(url.includes('/status') ? dirty : { removed: true }))
    vi.stubGlobal('fetch', fetchMock)
    const ask = vi.fn((_message: string) => true)
    expect(await offerRemoveWorktree('/wt', ask)).toBe('removed')
    expect(ask.mock.calls[0][0]).toContain('1 uncommitted change (will be lost)')
    expect(ask.mock.calls[0][0]).toContain('Branch “feat” is kept.')
    const removeInit = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(String(removeInit[1].body))).toEqual({ path: '/wt', confirm: true })
  })

  it('declined or not a worktree → nothing removed', async () => {
    const fetchMock = vi.fn(async () => jsonRes(dirty))
    vi.stubGlobal('fetch', fetchMock)
    expect(await offerRemoveWorktree('/wt', () => false)).toBe('kept')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ managed: false })))
    const ask = vi.fn(() => true)
    expect(await offerRemoveWorktree('/plain', ask)).toBe('kept')
    expect(ask).not.toHaveBeenCalled()
  })

  it('clean worktree message has no warning', () => {
    expect(removeWorktreeMessage({ managed: true, path: '/wt', branch: 'b', dirtyCount: 0, unpushed: 0 })).not.toContain('Warning')
  })
})

describe('WorkspaceWorktreeBadge', () => {
  it('shows branch and a dirty marker for a managed worktree, nothing for a plain folder', () => {
    const { container, unmount } = render(<WorkspaceWorktreeBadge status={{ managed: true, path: '/wt', branch: 'feat', dirtyCount: 3, unpushed: 0 }} />)
    expect(screen.getByText(/feat •/)).toBeTruthy()
    expect(container.querySelector('[data-dirty]')?.getAttribute('title')).toContain('3 uncommitted changes')
    unmount()
    const plain = render(<WorkspaceWorktreeBadge status={{ managed: false }} />)
    expect(plain.container.textContent).toBe('')
  })
})
