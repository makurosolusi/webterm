/** @vitest-environment jsdom */
// Source Control panel DOM: groups, secret refusal reason, Rule 9 gate on Commit, hook failure ->
// "Fix with agent" through the outbox, and Push gated by the pre-push report. API is faked.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './vscode/test-setup'
import type { ScmReport, ScmStatus } from '../server/gitScm.types'

const api = vi.hoisted(() => ({
  fetchStatus: vi.fn(), fetchReport: vi.fn(), fetchHunks: vi.fn(), stagePath: vi.fn(), unstagePath: vi.fn(),
  generateMessage: vi.fn(), commitStaged: vi.fn(), runReport: vi.fn(), pushBranch: vi.fn(), createPr: vi.fn(), sendFixToAgent: vi.fn(),
}))
vi.mock('./ScmPanel.api', async (orig) => ({ ...(await orig<typeof import('./ScmPanel.api')>()), ...api }))

import { ScmApiError } from './ScmPanel.api'
import { ScmPanel } from './ScmPanel'
import { pushAllowed } from './ScmPanel.report'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const STATUS: ScmStatus = {
  root: '/repo', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, gh: true,
  staged: { entries: [{ path: 'a.ts', code: 'M', sensitive: false }], total: 1 },
  unstaged: { entries: [{ path: 'b.ts', code: 'M', sensitive: false }], total: 1 },
  untracked: { entries: [{ path: '.env', code: '?', sensitive: true, sensitivePattern: '.env' }], total: 1 },
}
const report = (over: Partial<ScmReport> = {}): ScmReport => ({
  root: '/repo', head: 'h', createdAt: 0, green: true, credentials: [], debt: [],
  checks: [{ name: 'test', status: 'pass', detail: 'npm run test', durationMs: 1, output: '' }], ...over,
})

async function openPanel(agentId: string | null = 'ag') {
  api.fetchStatus.mockResolvedValue(STATUS)
  api.fetchReport.mockResolvedValue(null)
  const { container } = render(<ScmPanel root="/repo" agentId={agentId} />)
  const details = container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  await screen.findByText('Staged Changes (1)')
  return container
}
const button = (name: string | RegExp) => screen.getByText(name).closest('vscode-button') as HTMLElement
// The @lit/react wrapper does not reflect `disabled` under jsdom, so the gates are asserted by behaviour:
// a click on a gated button must not reach the API (the handlers re-check, the server checks again).

describe('ScmPanel', () => {
  it('loads nothing until opened, then shows the three groups', async () => {
    api.fetchStatus.mockResolvedValue(STATUS)
    render(<ScmPanel root="/repo" agentId={null} />)
    expect(api.fetchStatus).not.toHaveBeenCalled()
    cleanup()
    await openPanel()
    expect(screen.getByText('Changes (1)')).toBeTruthy()
    expect(screen.getByText('Untracked (1)')).toBeTruthy()
  })

  it('shows why a secret file is refused and offers no Stage button for it', async () => {
    await openPanel()
    expect(screen.getByText(/Secret file \(matches \.env\); never staged/)).toBeTruthy()
    expect(screen.queryByLabelText('Stage .env')).toBeNull()
    fireEvent.click(screen.getByLabelText('Stage b.ts'))
    await waitFor(() => expect(api.stagePath).toHaveBeenCalledWith('/repo', 'b.ts'))
  })

  it('blocks Commit until the message follows Rule 9', async () => {
    await openPanel()
    const commit = () => button('Commit (1)')
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'update stuff' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(commit())
    expect(api.commitStaged).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'feat(scm): add source control panel' } })
    api.commitStaged.mockResolvedValue({ ok: true, head: 'x' })
    fireEvent.click(commit())
    await waitFor(() => expect(api.commitStaged).toHaveBeenCalledWith('/repo', 'feat(scm): add source control panel'))
  })

  it('fills the box from Generate with AI', async () => {
    await openPanel()
    api.generateMessage.mockResolvedValue({ message: 'fix(scm): refuse secret files', problem: null })
    fireEvent.click(screen.getByText('Generate with AI'))
    await waitFor(() => expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe('fix(scm): refuse secret files'))
  })

  it('shows hook output inline and sends it to the wired agent with Fix with agent', async () => {
    await openPanel('ag')
    api.commitStaged.mockRejectedValue(new ScmApiError('Commit: failed', { error: 'commit_failed', output: 'eslint: 2 errors', fixPrompt: 'FIX PROMPT' }))
    api.sendFixToAgent.mockResolvedValue({})
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'feat(scm): add panel' } })
    fireEvent.click(button('Commit (1)'))
    expect((await screen.findByLabelText('Commit failure output')).textContent).toBe('eslint: 2 errors')
    fireEvent.click(screen.getByText('Fix with agent'))
    await waitFor(() => expect(api.sendFixToAgent).toHaveBeenCalledWith('ag', 'FIX PROMPT', expect.any(String)))
  })

  it('pushes only after a green report, or a red one acknowledged', async () => {
    const container = await openPanel()
    fireEvent.click(button('Push'))
    expect(api.pushBranch).not.toHaveBeenCalled() // no report yet
    api.runReport.mockResolvedValue(report({ green: false, checks: [{ name: 'lint', status: 'fail', detail: 'npm run lint', durationMs: 1, output: 'bad' }] }))
    fireEvent.click(screen.getByText('Run pre-push checks'))
    await screen.findByText('npm run lint')
    expect(container.querySelector('[data-status="fail"]')?.textContent).toContain('lint: fail')
    fireEvent.click(button('Push'))
    expect(api.pushBranch).not.toHaveBeenCalled() // red, not acknowledged
    fireEvent.click(screen.getByLabelText(/I acknowledge the failed checks/))
    api.pushBranch.mockResolvedValue({ ok: true, output: '' })
    fireEvent.click(button('Push'))
    await waitFor(() => expect(api.pushBranch).toHaveBeenCalledWith('/repo', true))
  })

  it('a credential finding blocks Push with no acknowledge option', () => {
    const leak = report({ green: false, credentials: [{ path: 'k.ts', line: 1, text: 'credential-shaped value' }] })
    expect(pushAllowed(leak, true)).toBe(false)
    expect(pushAllowed(report(), false)).toBe(true)
    expect(pushAllowed(null, true)).toBe(false)
  })
})
