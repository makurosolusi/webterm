/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoutinesPanel, type RoutineRun, type RoutineView } from './RoutinesPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const AT = 1_700_000_000_000 // test-only
const TEMPLATE = {
  id: 'weekly-missing-tests', name: 'Weekly: find missing tests', description: 'd',
  input: { name: 'Weekly: find missing tests', trigger: { type: 'schedule', cron: '0 9 * * 1' }, precheck: { command: 'true', timeoutSeconds: 30 },
    action: { type: 'spawn', prompt: 'Find gaps' }, budget: { maxRunsPerDay: 1, maxCostUsdPerDay: 2 } },
}

/** Fake `/api/routines` + `/api/workspaces`: routines in memory, every write recorded. */
function server(initial: RoutineView[], runs: RoutineRun[] = []) {
  let routines = [...initial]
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/workspaces') return new Response(JSON.stringify([{ id: 'w1', name: 'webterm', cwd: '/tmp/w1' }]))
    if (method === 'GET' && url.includes('/runs')) return new Response(JSON.stringify({ runs }))
    if (method === 'GET') return new Response(JSON.stringify({ routines, templates: [TEMPLATE] }))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    if (method === 'POST' && url === '/api/routines') routines = [...routines, { ...(body as unknown as RoutineView), id: 'r2', tier: 'R2', nextRunAt: null, lastRun: null }]
    if (method === 'DELETE') routines = routines.filter((r) => !url.endsWith(r.id))
    return new Response(JSON.stringify({ ok: true }), { status: method === 'POST' ? 201 : 200 })
  }))
  return { writes }
}

const routine: RoutineView = {
  id: 'r1', name: 'Nightly tests', enabled: true, workspaceId: null, trigger: { type: 'schedule', cron: '0 2 * * *' }, precheck: null,
  action: { type: 'spawn', prompt: 'p' }, budget: { maxRunsPerDay: 1, maxCostUsdPerDay: null }, tier: 'R2', nextRunAt: AT,
  lastRun: { id: 'x', trigger: 'schedule', status: 'skipped', reason: 'precheck exited 1', startedAt: AT, costUsd: null },
}

describe('Routines (Settings › Control)', () => {
  it('lists routines with trigger, tier and the last skip reason; Run now and history', async () => {
    const { writes } = server([routine], [{ id: 'a', trigger: 'catch_up', status: 'ran', reason: null, startedAt: AT, costUsd: 0.5, estimateUsd: 0.4 }])
    render(<RoutinesPanel />)
    expect(await screen.findByText('Nightly tests')).toBeTruthy()
    expect(screen.getByText(/Custom schedule \(0 2 \* \* \*\) · R2/)).toBeTruthy()
    expect(screen.getByTestId('last-run').textContent).toBe('skipped — precheck exited 1')
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(writes[0]).toEqual({ method: 'POST', url: '/api/routines/r1/run' }))
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    const list = await screen.findByRole('list', { name: 'History: Nightly tests' })
    expect(list.textContent).toContain('catch_up · ran')
    expect(list.textContent).toContain('$0.50 · est. $0.40')
  })

  it('shows the run estimate next to a skipped run that never spent', async () => {
    server([{ ...routine, lastRun: { ...routine.lastRun!, reason: 'budget: cap', estimateUsd: 2 } }])
    render(<RoutinesPanel />)
    expect((await screen.findByTestId('last-run')).textContent).toBe('skipped — budget: cap · est. $2.00')
  })

  it('toggling Enabled sends the whole definition with enabled flipped', async () => {
    const { writes } = server([routine])
    render(<RoutinesPanel />)
    fireEvent.click(await screen.findByLabelText('Enabled: Nightly tests'))
    await waitFor(() => expect(writes[0]?.method).toBe('PUT'))
    expect(writes[0]).toMatchObject({ url: '/api/routines/r1', body: { name: 'Nightly tests', enabled: false, trigger: { type: 'schedule', cron: '0 2 * * *' } } })
    expect(writes[0]!.body).not.toHaveProperty('lastRun')
  })

  it('creates a routine from a template into a chosen workspace', async () => {
    const { writes } = server([])
    render(<RoutinesPanel />)
    expect(await screen.findByText('No routines yet.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Start from a template…'), { target: { value: 'weekly-missing-tests' } })
    const form = await screen.findByRole('form', { name: 'Routine' })
    expect((screen.getByLabelText('Schedule') as HTMLInputElement).value).toBe('0 9 * * 1')
    expect((screen.getByTestId('routine-more') as HTMLDetailsElement).open).toBe(true) // the template has a check command
    await waitFor(() => expect(screen.getByRole('option', { name: 'webterm' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'w1' } })
    fireEvent.submit(form)
    await waitFor(() => expect(writes[0]?.method).toBe('POST'))
    expect(writes[0]!.body).toMatchObject({ name: 'Weekly: find missing tests', workspaceId: 'w1', enabled: true, precheck: { command: 'true' }, budget: { maxRunsPerDay: 1 } })
    expect(await screen.findByText('Weekly: find missing tests', { selector: 'strong' })).toBeTruthy()
  })

  it('a preset schedule shows in plain words; Edit picks another preset and saves its cron', async () => {
    const { writes } = server([{ ...routine, trigger: { type: 'schedule', cron: '0 9 * * 1-5' } }])
    render(<RoutinesPanel />)
    expect(await screen.findByText(/Weekdays at 9:00 · R2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const form = await screen.findByRole('form', { name: 'Routine' })
    fireEvent.click(within(form).getAllByRole('button', { name: 'Show suggestions' })[0]!)
    fireEvent.click(screen.getByRole('option', { name: /^Every hour/ }))
    fireEvent.submit(form)
    await waitFor(() => expect(writes[0]?.method).toBe('PUT'))
    expect(writes[0]).toMatchObject({ url: '/api/routines/r1', body: { trigger: { type: 'schedule', cron: '0 * * * *' } } })
  })

  it('shows the server error when a save is refused', async () => {
    server([])
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/workspaces') return new Response('[]')
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ routines: [], templates: [] }))
      return new Response(JSON.stringify({ error: 'cron minute out of range' }), { status: 400 })
    }))
    render(<RoutinesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New routine' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Routine' }))
    expect((await screen.findByRole('alert')).textContent).toContain('cron minute out of range')
    expect(screen.getByRole('form', { name: 'Routine' })).toBeTruthy() // form stays open
  })
})
