/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvalCasesPanel, type EvalCaseView } from './EvalCasesPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const AT = 1_700_000_000_000 // test-only
const PLAN: EvalCaseView = {
  id: 'c1', source: 'central_plan', contextRef: 'conversation:central:project:p1', inputText: 'Free some disk on staging',
  proposed: { tool: 'goal.propose', summary: 'goal.propose' }, rejection: { by: 'human:loopback', how: 'approval' }, reason: null, status: 'new', rejectedAt: AT,
}

/** Fake `/api/evalcases`: records every request. */
function server(cases: EvalCaseView[]) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url.endsWith('/export')) return new Response(JSON.stringify({ format: 'webterm-eval-cases/1', cases: [] }))
    if (method === 'GET') {
      const status = new URL(url, 'http://x').searchParams.get('status')
      const list = cases.filter((c) => c.status === status)
      return new Response(JSON.stringify({ cases: list, total: list.length }))
    }
    return new Response(JSON.stringify({ case: { ...PLAN, status: 'promoted' } }))
  }))
  return { calls }
}

describe('Eval cases (Settings › Developer)', () => {
  it('lists new cases with source, summary, input and who rejected them', async () => {
    server([PLAN])
    render(<EvalCasesPanel />)
    expect(await screen.findByText('Central plan rejected')).toBeTruthy()
    const item = screen.getByRole('list', { name: 'Eval cases' })
    expect(item.textContent).toContain('goal.propose')
    expect(item.textContent).toContain('Free some disk on staging')
    expect(item.textContent).toContain('rejected by human:loopback')
    expect(screen.getByText(/^Saved examples used to test agent behaviour\./)).toBeTruthy()
  })

  it('Promote to golden sends the typed reason; an empty reason is not sent', async () => {
    const { calls } = server([PLAN])
    render(<EvalCasesPanel />)
    fireEvent.change(await screen.findByLabelText('Why did you reject it? (optional)'), { target: { value: 'never touch staging' } })
    fireEvent.click(screen.getByRole('button', { name: 'Promote to golden' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/api/evalcases/c1/promote', body: { reason: 'never touch staging' } })
    fireEvent.change(screen.getByLabelText('Why did you reject it? (optional)'), { target: { value: '  ' } })
    // Both buttons stay off until the first decision settles.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'POST')[1]).toEqual({ method: 'POST', url: '/api/evalcases/c1/dismiss', body: {} })
  })

  it('the status segmented control switches the list; Export JSON downloads the dataset', async () => {
    const { calls } = server([PLAN, { ...PLAN, id: 'c2', status: 'promoted', proposed: { tool: 'Bash', summary: 'Bash: rm -rf build' } }])
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    render(<EvalCasesPanel />)
    await screen.findByText('Central plan rejected')
    expect(screen.getByRole('radiogroup', { name: 'Show' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'New' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Golden' }))
    expect(screen.getByRole('radio', { name: 'Golden' }).getAttribute('aria-checked')).toBe('true')
    expect(await screen.findByText(/Bash: rm -rf build/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Promote to golden' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    expect(calls.some((c) => c.url === '/api/evalcases/export')).toBe(true)
  })

  it('shows an alert when an action fails', async () => {
    server([PLAN])
    render(<EvalCasesPanel />)
    await screen.findByText('Central plan rejected')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const busy = screen.getByRole('button', { name: /Dismissing/ })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: 'Promote to golden' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(document.querySelector('[data-action-result="failed"]')?.textContent).toContain('Dismiss failed: not_found'))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy() // failure toast offers Retry
  })
})
