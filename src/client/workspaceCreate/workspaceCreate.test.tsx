/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import Welcome from '../Welcome'
import WorkspaceBar from '../WorkspaceBar'
import WorkspaceCreateHost, { openWorkspaceCreate } from './WorkspaceCreateHost'
import { PARENT_KEY } from './workspaceCreate.api'

type Call = { url: string; body: unknown }
let calls: Call[]
/** Feeds NDJSON lines to the open clone response; test-only. */
let push: (o: unknown) => void
let finish: () => void

function cloneStream(): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (o) => c.enqueue(enc.encode(`${JSON.stringify(o)}\n`))
      finish = () => c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
}

beforeEach(() => {
  calls = []
  localStorage.clear()
  // Radix Checkbox measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (url.endsWith('/defaults')) return Response.json({ parent: '/home/u/projects' })
    if (url.endsWith('/clone')) return cloneStream()
    if (url.endsWith('/clone/cancel')) return Response.json({ aborted: true })
    if (url.endsWith('/project')) {
      const b = body as { name: string }
      return b.name === 'taken'
        ? Response.json({ error: 'exists', message: '"/home/u/projects/taken" already exists and is not empty.' }, { status: 409 })
        : Response.json({ path: `/home/u/projects/${b.name}` }, { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mountHost = () => {
  const onCreated = vi.fn()
  const onOpenFolder = vi.fn()
  render(<WorkspaceCreateHost onCreated={onCreated} onOpenFolder={onOpenFolder} />)
  return { onCreated, onOpenFolder }
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('Clone repository dialog', () => {
  it('expands owner/repo, derives the folder, streams progress, then opens the clone', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).toBe('/home/u/projects'))
    type('Repository URL', 'vercel/next.js')
    expect(screen.getByText('→ https://github.com/vercel/next.js.git')).toBeTruthy()
    expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('next.js')
    type('Folder name', 'next')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/clone'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/clone'))?.body).toEqual({ url: 'https://github.com/vercel/next.js.git', parent: '/home/u/projects', name: 'next' })
    act(() => push({ type: 'progress', phase: 'Receiving objects', percent: 42 }))
    await waitFor(() => expect(screen.getByText('Receiving objects… 42%')).toBeTruthy())
    act(() => { push({ type: 'done', path: '/home/u/projects/next' }); finish() })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/home/u/projects/next'))
    expect(screen.queryByTestId('clone-repo-dialog')).toBeNull()
    expect(localStorage.getItem(PARENT_KEY)).toBe('/home/u/projects')
  })

  it('shows a readable error (auth hint) and stays open', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).not.toBe(''))
    type('Repository URL', 'o/private')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/clone'))).toBe(true))
    act(() => { push({ type: 'error', error: 'git_failed', message: 'fatal: Authentication failed — Authentication required: run `gh auth login`' }); finish() })
    expect((await screen.findByRole('alert')).textContent).toContain('gh auth login')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('Cancel during a clone asks the server to abort and closes', async () => {
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    localStorage.setItem(PARENT_KEY, '/remembered')
    type('Repository URL', 'git@github.com:o/r.git')
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).not.toBe(''))
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await screen.findByText('Starting clone…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/clone/cancel'))).toBe(true))
    expect(screen.queryByTestId('clone-repo-dialog')).toBeNull()
  })

  it('refuses file: and option-looking URLs in the form', async () => {
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    type('Repository URL', 'file:///etc')
    expect(screen.getByText(/Use an https:\/\/ or git@host/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses the remembered parent over the server default', async () => {
    localStorage.setItem(PARENT_KEY, '/remembered')
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).toBe('/remembered'))
    expect(calls.some((c) => c.url.endsWith('/defaults'))).toBe(false)
  })
})

describe('New project dialog', () => {
  it('creates with git init on by default and opens the folder', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('project'))
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).toBe('/home/u/projects'))
    expect(screen.getByRole('checkbox', { name: 'Initialize git repository' }).getAttribute('aria-checked')).toBe('true')
    type('Project name', 'demo')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/home/u/projects/demo'))
    expect(calls.find((c) => c.url.endsWith('/project'))?.body).toEqual({ parent: '/home/u/projects', name: 'demo', gitInit: true })
  })

  it('sends gitInit false when unticked and shows a non-empty-folder error', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('project'))
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).not.toBe(''))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Initialize git repository' }))
    type('Project name', 'taken')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists and is not empty')
    expect(calls.find((c) => c.url.endsWith('/project'))?.body).toEqual({ parent: '/home/u/projects', name: 'taken', gitInit: false })
    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe('entry points', () => {
  it('Welcome offers all three: New project and Clone open the dialogs, Open folder picks a folder', async () => {
    const onNewProject = vi.fn()
    mountHost()
    render(<Welcome onNewProject={onNewProject} onCreateEmpty={() => {}} />)
    fireEvent.click(screen.getByText('Open folder…'))
    expect(onNewProject).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Clone repo…'))
    expect(await screen.findByTestId('clone-repo-dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByText('New project'))
    expect(await screen.findByTestId('new-project-dialog')).toBeTruthy()
  })
})

describe('WorkspaceBar +', () => {
  it('offers Open Folder, Clone Repository and New Project; a created folder opens as a workspace', async () => {
    const onNewWorkspace = vi.fn()
    render(<WorkspaceBar workspaces={[]} activeId={null} liveActiveNodes={null} statuses={{}}
      onSelect={vi.fn()} onNewWorkspace={onNewWorkspace} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('New workspace'))
    fireEvent.click(await screen.findByText('Open Folder…'))
    expect(onNewWorkspace).toHaveBeenCalledWith()
    fireEvent.click(screen.getByLabelText('New workspace'))
    fireEvent.click(await screen.findByText('New Project…'))
    await waitFor(() => expect((screen.getByLabelText('Parent folder') as HTMLInputElement).value).toBe('/home/u/projects'))
    type('Project name', 'fromBar')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onNewWorkspace).toHaveBeenLastCalledWith('/home/u/projects/fromBar'))
    fireEvent.click(screen.getByLabelText('New workspace'))
    fireEvent.click(await screen.findByText('Clone Repository…'))
    expect(await screen.findByTestId('clone-repo-dialog')).toBeTruthy()
  })
})
