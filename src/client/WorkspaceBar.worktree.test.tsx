/** @vitest-environment jsdom */
// WorkspaceBar + worktree workspaces: dirty dot and branch tooltip on the tab, badge next to the
// active name, and Delete offering to remove the worktree (dirty work only after its warning,
// workspace kept when removal fails). The status/remove API is faked through `fetch`.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import WorkspaceBar from './WorkspaceBar'
import { DEFAULT_VIEWPORT, type Workspace } from '../shared/workspace'
import type { WorktreeStatus } from './workspaceWorktree.api'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const ws = (id: string, name: string, cwd: string): Workspace =>
  ({ id, name, cwd, viewport: DEFAULT_VIEWPORT, nodes: [], bridges: [], updatedAt: 0 }) // test-only
const WT: WorktreeStatus = { managed: true, path: '/data/worktrees/proj/feat', branch: 'feat', dirty: ['?? a'], dirtyCount: 1, unpushed: 0 }
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function mount(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl)
  vi.stubGlobal('fetch', fetchMock)
  const onDeleteWorkspace = vi.fn()
  render(
    <WorkspaceBar
      workspaces={[ws('w1', 'Feat', WT.path!), ws('w2', 'Plain', '/plain')]}
      activeId="w1" liveActiveNodes={[]} statuses={{}}
      onSelect={vi.fn()} onNewWorkspace={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={onDeleteWorkspace}
    />,
  )
  return { fetchMock, onDeleteWorkspace }
}
const statusFetch = (extra?: (url: string, init?: RequestInit) => Response | null) => async (url: string, init?: RequestInit) =>
  extra?.(url, init) ?? jsonRes(url.includes(encodeURIComponent(WT.path!)) ? WT : { managed: false })

async function openDelete() {
  fireEvent.contextMenu(screen.getByRole('tab', { name: /Feat/ }), { clientX: 10, clientY: 10 })
  fireEvent.click(await screen.findByText('Delete'))
}

/** Visible tooltip text of a trigger (focus opens it immediately), then closes it again. */
const tipOf = (el: Element): string | null | undefined => {
  fireEvent.keyDown(document, { key: 'Tab' }) // keyboard navigation: focus alone does not open a tooltip
  fireEvent.focus(el)
  const text = document.querySelector('[role="tooltip"]')?.textContent
  fireEvent.blur(el)
  return text
}

describe('WorkspaceBar worktree state', () => {
  it('marks the worktree tab dirty with the branch in its tooltip and shows the badge by the active name', async () => {
    mount(statusFetch())
    await screen.findByText(/feat •/)
    const tabs = screen.getAllByRole('tab')
    const feat = tabs.find((t) => t.textContent?.includes('Feat'))!
    await waitFor(() => expect(tipOf(feat)).toContain('Worktree branch feat, 1 uncommitted change'))
    expect(feat.closest('[data-dirty]')?.getAttribute('data-dirty') ?? feat.getAttribute('data-dirty')).toBe('true')
    const plain = tabs.find((t) => t.textContent?.includes('Plain'))!
    expect(tipOf(plain) ?? '').not.toContain('Worktree')
  })
})

describe('WorkspaceBar delete offers worktree removal', () => {
  it('confirm workspace, confirm worktree → remove with confirm, then delete the workspace', async () => {
    const { fetchMock, onDeleteWorkspace } = mount(statusFetch((url) => (url.includes('/remove') ? jsonRes({ removed: true }) : null)))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openDelete()
    await waitFor(() => expect(onDeleteWorkspace).toHaveBeenCalledWith('w1'))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1][0]).toContain('Branch “feat” is kept.')
    const remove = fetchMock.mock.calls.find(([u]) => String(u).includes('/remove'))!
    expect(JSON.parse(String(remove[1]?.body))).toEqual({ path: WT.path, confirm: true })
  })

  it('declining the worktree prompt still deletes the workspace but leaves the worktree', async () => {
    const { fetchMock, onDeleteWorkspace } = mount(statusFetch())
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
    await openDelete()
    await waitFor(() => expect(onDeleteWorkspace).toHaveBeenCalledWith('w1'))
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/remove'))).toBe(false)
  })

  it('an unreadable worktree status does not block deleting the workspace', async () => {
    const { fetchMock, onDeleteWorkspace } = mount(async () => jsonRes({ error: 'down' }, 500))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openDelete()
    await waitFor(() => expect(onDeleteWorkspace).toHaveBeenCalledWith('w1'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/remove'))).toBe(false)
  })

  it('cancelling the workspace prompt touches nothing; a failed removal keeps the workspace', async () => {
    const { onDeleteWorkspace } = mount(statusFetch((url) => (url.includes('/remove') ? jsonRes({ error: 'git_failed', message: 'locked' }, 500) : null)))
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    await openDelete()
    expect(onDeleteWorkspace).not.toHaveBeenCalled()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    await openDelete()
    await waitFor(() => expect(alert).toHaveBeenCalled())
    expect(String(alert.mock.calls[0][0])).toContain('Workspace not deleted')
    expect(onDeleteWorkspace).not.toHaveBeenCalled()
  })
})
