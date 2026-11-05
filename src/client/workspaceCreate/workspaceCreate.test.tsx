/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../vscode/test-setup'
import Welcome from '../Welcome'
import WorkspaceBar from '../WorkspaceBar'
import WorkspaceCreateHost, { openWorkspaceCreate } from './WorkspaceCreateHost'
import { PARENT_KEY, PROJECT_PARENT_KEY, type Preflight } from './workspaceCreate.api'

type Call = { path: string; query: URLSearchParams; body: unknown }
let calls: Call[]
/** Feeds NDJSON lines to the open clone response; test-only. */
let push: (o: unknown) => void
let finish: () => void
/** Preflight answer per request body; default: free target, no warnings. test-only */
let check: (b: { parent: string; name: string; url?: string }) => Partial<Preflight>
/** Folders the fake server treats as existing directories. test-only */
let dirs: Set<string>

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

const DEFAULT = '/home/u/webterm/projects'

beforeEach(() => {
  calls = []
  dirs = new Set()
  check = () => ({})
  localStorage.clear()
  // Radix Checkbox measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (raw: string, init?: RequestInit) => {
    const u = new URL(raw, 'http://x')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: u.pathname, query: u.searchParams, body })
    const sub = u.pathname.replace('/api/workspace-create', '')
    if (sub === '/defaults') {
      const r = u.searchParams.get('remembered') ?? ''
      return Response.json({ parent: dirs.has(r) ? r : DEFAULT, projectsFolder: DEFAULT, builtin: DEFAULT })
    }
    if (sub === '/check') {
      const b = body as { parent: string; name: string }
      return Response.json({ target: `${b.parent}/${b.name}`, taken: false, suggestion: null, warnings: [], existing: null, existingSkipped: false, ...check(body) })
    }
    if (sub === '/clone') return cloneStream()
    if (sub === '/clone/cancel') return Response.json({ aborted: true })
    if (sub === '/reveal') return Response.json({ ok: true })
    if (sub === '/project') {
      const b = body as { name: string; parent: string }
      return b.name === 'race'
        ? Response.json({ error: 'exists', message: `"${b.parent}/race" already exists and is not empty.` }, { status: 409 })
        : Response.json({ path: `${b.parent}/${b.name}` }, { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mountHost = () => {
  const onCreated = vi.fn()
  const onOpenFolder = vi.fn()
  const onOpenWorkspace = vi.fn()
  render(<WorkspaceCreateHost onCreated={onCreated} onOpenFolder={onOpenFolder} onOpenWorkspace={onOpenWorkspace} />)
  return { onCreated, onOpenFolder, onOpenWorkspace }
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const parentValue = () => (screen.getByLabelText('Parent folder') as HTMLInputElement).value
const posted = (sub: string) => calls.filter((c) => c.path === `/api/workspace-create${sub}`)

describe('Clone repository dialog', () => {
  it('shows the full target, streams progress, then a success state with Reveal and Copy path', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    type('Repository URL', 'vercel/next.js')
    expect(screen.getByText('→ https://github.com/vercel/next.js.git')).toBeTruthy()
    expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('next.js')
    type('Folder name', 'next')
    expect(screen.getByTestId('target-path').textContent).toBe(`Will be created at ${DEFAULT}/next`)
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(posted('/clone')).toHaveLength(1))
    expect(posted('/check')[0].body).toEqual({ parent: DEFAULT, name: 'next', url: 'https://github.com/vercel/next.js.git' })
    expect(posted('/clone')[0].body).toEqual({ url: 'https://github.com/vercel/next.js.git', parent: DEFAULT, name: 'next' })
    act(() => push({ type: 'progress', phase: 'Receiving objects', percent: 42 }))
    await waitFor(() => expect(screen.getByText('Receiving objects… 42%')).toBeTruthy())
    act(() => { push({ type: 'done', path: `${DEFAULT}/next` }); finish() })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(`${DEFAULT}/next`))
    expect(screen.getByTestId('created-panel').textContent).toContain(`${DEFAULT}/next`)
    expect(localStorage.getItem(PARENT_KEY)).toBe(DEFAULT)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    await waitFor(() => expect(posted('/reveal')[0]?.body).toEqual({ path: `${DEFAULT}/next` }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${DEFAULT}/next`))
    expect(await screen.findByText('Path copied.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('clone-repo-dialog')).toBeNull()
  })

  it('already cloned: Open switches to that workspace without cloning', async () => {
    check = () => ({ existing: { path: '/code/r', workspaceId: 'ws-1' } })
    const { onOpenWorkspace, onCreated } = mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    type('Repository URL', 'git@github.com:o/r.git')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect((await screen.findByTestId('notice-existing')).textContent).toContain('Already cloned at /code/r — Open it?')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenWorkspace).toHaveBeenCalledWith('ws-1')
    expect(onCreated).not.toHaveBeenCalled()
    expect(posted('/clone')).toHaveLength(0)
    expect(screen.queryByTestId('clone-repo-dialog')).toBeNull()
  })

  it('already cloned in a folder with no workspace: Open makes one for it', async () => {
    check = () => ({ existing: { path: '/code/r' } })
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    type('Repository URL', 'o/r')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(onCreated).toHaveBeenCalledWith('/code/r')
  })

  it('Clone again anyway, then name taken offers the next free name and keeps the answer', async () => {
    check = (b) => ({ existing: { path: `${b.parent}/r` }, taken: b.name === 'r', suggestion: b.name === 'r' ? 'r-2' : null })
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    type('Repository URL', 'o/r')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clone again anyway' }))
    expect((await screen.findByTestId('notice-taken')).textContent).toContain('r already exists here.')
    fireEvent.click(screen.getByRole('button', { name: 'Use r-2' }))
    expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('r-2')
    expect(screen.getByTestId('target-path').textContent).toBe(`Will be created at ${DEFAULT}/r-2`)
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(posted('/clone')).toHaveLength(1))
    expect(posted('/clone')[0].body).toMatchObject({ name: 'r-2' })
  })

  it('shows a readable error (auth hint) and stays open', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).not.toBe(''))
    type('Repository URL', 'o/private')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(posted('/clone')).toHaveLength(1))
    act(() => { push({ type: 'error', error: 'git_failed', message: 'fatal: Authentication failed — Authentication required: run `gh auth login`' }); finish() })
    expect((await screen.findByRole('alert')).textContent).toContain('gh auth login')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('Cancel during a clone asks the server to abort and closes', async () => {
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    type('Repository URL', 'git@github.com:o/r.git')
    await waitFor(() => expect(parentValue()).not.toBe(''))
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await screen.findByText('Starting clone…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(posted('/clone/cancel')).toHaveLength(1))
    expect(screen.queryByTestId('clone-repo-dialog')).toBeNull()
  })

  it('refuses file: and option-looking URLs in the form', async () => {
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    type('Repository URL', 'file:///etc')
    expect(screen.getByText(/Use an https:\/\/ or git@host/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('suggests the remembered parent while it exists, else the default projects folder', async () => {
    localStorage.setItem(PARENT_KEY, '/remembered')
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT)) // server says it is gone
    expect(posted('/defaults')[0].query.get('remembered')).toBe('/remembered')
    cleanup()
    dirs.add('/remembered')
    mountHost()
    act(() => openWorkspaceCreate('clone'))
    await waitFor(() => expect(parentValue()).toBe('/remembered'))
  })
})

describe('New project dialog', () => {
  it('creates with git init on by default, remembers its own parent', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('project'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    expect(screen.getByRole('checkbox', { name: 'Initialize git repository' }).getAttribute('aria-checked')).toBe('true')
    type('Project name', 'demo')
    expect(screen.getByTestId('target-path').textContent).toBe(`Will be created at ${DEFAULT}/demo`)
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(`${DEFAULT}/demo`))
    expect(posted('/project')[0].body).toEqual({ parent: DEFAULT, name: 'demo', gitInit: true })
    expect(posted('/check')[0].body).toEqual({ parent: DEFAULT, name: 'demo' })
    expect(localStorage.getItem(PROJECT_PARENT_KEY)).toBe(DEFAULT)
    expect(screen.getByTestId('created-panel')).toBeTruthy()
  })

  it('wrong-place warning needs "Create anyway"; a blocking one offers no way past', async () => {
    check = (b) => (b.parent === '/data'
      ? { warnings: [{ code: 'data_dir', blocking: true, message: 'This is inside the webterm data folder, which holds its database. Pick another folder.' }] }
      : { warnings: [{ code: 'inside_repo', blocking: false, message: 'This is inside another git repository (/code/mono).' }] })
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('project'))
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    type('Parent folder', '/data')
    type('Project name', 'p')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect((await screen.findByTestId('notice-blocked')).textContent).toContain('webterm data folder')
    expect(screen.queryByRole('button', { name: 'Create anyway' })).toBeNull()
    type('Parent folder', '/code/mono/pkgs')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect((await screen.findByTestId('notice-warn')).textContent).toContain('inside another git repository')
    expect(posted('/project')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('/code/mono/pkgs/p'))
  })

  it('sends gitInit false when unticked; a server refusal still shows', async () => {
    const { onCreated } = mountHost()
    act(() => openWorkspaceCreate('project'))
    await waitFor(() => expect(parentValue()).not.toBe(''))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Initialize git repository' }))
    type('Project name', 'race')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists and is not empty')
    expect(posted('/project')[0].body).toEqual({ parent: DEFAULT, name: 'race', gitInit: false })
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
    await waitFor(() => expect(parentValue()).toBe(DEFAULT))
    type('Project name', 'fromBar')
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onNewWorkspace).toHaveBeenLastCalledWith(`${DEFAULT}/fromBar`))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByLabelText('New workspace'))
    fireEvent.click(await screen.findByText('Clone Repository…'))
    expect(await screen.findByTestId('clone-repo-dialog')).toBeTruthy()
  })
})
