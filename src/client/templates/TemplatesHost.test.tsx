/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listCommands } from '../commandRegistry'
import type { Workspace } from '../../shared/workspace'
import TemplatesHost from './TemplatesHost'
import { NewFromTemplateDialog, SaveAsTemplateDialog } from './TemplatesDialogs'
import { reviewOf, type WebtermTemplate } from './templates.client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// test-only fixtures
const PLAN: WebtermTemplate = {
  format: 'webterm-template', version: 1, id: 'plan-worktree-workers', name: 'Plan → worktree workers', description: 'Plan plus workers.', builtin: true,
  cwd: '{{repo}}', params: [{ id: 'repo', description: 'Repository folder' }, { id: 'task', description: 'Intent' }],
  nodes: [
    { key: 'plan', kind: 'plan', x: 0, y: 0, plan: { intent: '{{task}}' } },
    { key: 'w1', kind: 'agent', x: 600, y: 0, agentId: 'claude', cmd: 'claude', worktree: { branch: 'feat-1' } },
  ],
  cables: [], routines: [{ name: 'Check', trigger: { type: 'api' }, precheck: { command: 'test -d .git', timeoutSeconds: 30 }, action: { type: 'prreview' }, budget: { maxRunsPerDay: 1, maxCostUsdPerDay: null } }],
}
const WS: Workspace = { id: 'ws1', name: 'Board', cwd: '/home/me/repo', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], bridges: [], updatedAt: 0 }
const HOSTILE = '$(rm -rf ~) `id`'

type Call = { url: string; method: string; body: unknown }
function stubApi(answer: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const r = c.method === 'GET' && url === '/api/templates' ? { status: 200, body: { templates: [PLAN] } } : answer(c)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}

describe('templates', () => {
  it('registers both ⌘K commands', () => {
    render(<TemplatesHost activeWs={WS} onCreated={() => {}} onPlace={() => {}} />)
    const labels = listCommands().map((c) => c.label)
    expect(labels).toContain('Workspace: New from Template…')
    expect(labels).toContain('Workspace: Save as Template…')
  })

  it('lists what will run, sends parameters as literal data and opens the new workspace', async () => {
    const created: Workspace = { ...WS, id: 'ws2', name: 'Plan → worktree workers' }
    const calls = stubApi(() => ({ status: 201, body: { workspace: created, routines: { created: 1, skipped: 0 } } }))
    const onCreated = vi.fn()
    render(<NewFromTemplateDialog activeWs={WS} onCreated={onCreated} onPlace={() => {}} onClose={() => {}} />)
    fireEvent.click(await screen.findByText(/Plan → worktree workers/))
    expect(screen.getByTestId('template-commands').textContent).toBe('claude')
    expect(screen.getByText(/precheck: test -d \.git/)).toBeTruthy()
    expect((screen.getByLabelText(/^repo/) as HTMLInputElement).value).toBe('/home/me/repo') // prefilled from the workspace
    fireEvent.change(screen.getByLabelText(/^task/), { target: { value: HOSTILE } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/templates/plan-worktree-workers/instantiate')
    expect(post.body).toEqual({ params: { repo: '/home/me/repo', task: HOSTILE }, name: 'Plan → worktree workers' })
  })

  it('places nodes on the active canvas when "This workspace" is chosen', async () => {
    const nodes = [{ id: 'n1', kind: 'plan' as const, x: 80, y: 0 }]
    stubApi(() => ({ status: 200, body: { workspaceId: 'ws1', nodes, bridges: [], routines: { created: 0, skipped: 0 } } }))
    const onPlace = vi.fn()
    render(<NewFromTemplateDialog activeWs={WS} onCreated={() => {}} onPlace={onPlace} onClose={() => {}} />)
    fireEvent.click(await screen.findByText(/Plan → worktree workers/))
    fireEvent.click(screen.getByText('This workspace'))
    fireEvent.change(screen.getByLabelText(/^task/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(onPlace).toHaveBeenCalledWith(nodes, []))
  })

  it('shows why an import was rejected', async () => {
    stubApi(() => ({ status: 400, body: { error: 'invalid_template', message: 'nodes[0].cmd may not contain {{parameters}}: commands are never parameterized' } }))
    render(<NewFromTemplateDialog activeWs={WS} onCreated={() => {}} onPlace={() => {}} onClose={() => {}} />)
    const file = new File([JSON.stringify({ format: 'webterm-template' })], 'evil.json', { type: 'application/json' })
    fireEvent.change(screen.getByTestId('template-import'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain('Import rejected: nodes[0].cmd may not contain')
  })

  it('saves the active workspace as a template', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) // Radix checkbox measures itself
    const calls = stubApi(() => ({ status: 201, body: { template: { ...PLAN, id: 'board-1', name: 'My board', builtin: undefined } } }))
    render(<SaveAsTemplateDialog ws={WS} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'My board' } })
    fireEvent.click(screen.getByText('Save'))
    expect((await screen.findByRole('status')).textContent).toContain('Saved "My board"')
    expect(calls[0].body).toEqual({ workspaceId: 'ws1', name: 'My board', description: '', includeRoutines: true })
  })

  it('reviewOf lists commands once and counts worktrees', () => {
    expect(reviewOf(PLAN)).toEqual({ commands: ['claude'], routines: ['Check (precheck: test -d .git)'], worktrees: 1 })
  })
})
