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
function server(initial: RoutineView[], runs: RoutineRun[] = [], runStatus: RoutineRun['status'] = 'running', templates: unknown[] = [TEMPLATE]) {
  let routines = [...initial]
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/workspaces') return new Response(JSON.stringify([{ id: 'w1', name: 'webterm', cwd: '/tmp/w1',
      nodes: [{ id: 'n-agent', kind: 'agent', title: 'brisk-otter' }, { id: 'n-term', kind: 'terminal', title: 'zsh' }] }]))
    if (method === 'GET' && url.includes('/runs')) return new Response(JSON.stringify({ runs }))
    if (method === 'GET') return new Response(JSON.stringify({ routines, templates }))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    writes.push({ method, url, ...(body ? { body } : {}) })
    if (method === 'POST' && url === '/api/routines') routines = [...routines, { ...(body as unknown as RoutineView), id: 'r2', tier: 'R2', nextRunAt: null, lastRun: null }]
    if (method === 'POST' && url.endsWith('/run')) return new Response(JSON.stringify({ run: { id: 'm', trigger: 'manual', status: runStatus, reason: runStatus === 'skipped' ? 'precheck exited 1' : null, startedAt: AT, costUsd: null } }), { status: 202 })
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

describe('Routines (Control › Automations)', () => {
  it('lists routines with trigger and the last skip reason in plain words; Run now says Started; history', async () => {
    const { writes } = server([routine], [{ id: 'a', trigger: 'catch_up', status: 'ran', reason: null, startedAt: AT, costUsd: 0.5, estimateUsd: 0.4 }])
    render(<RoutinesPanel />)
    expect(await screen.findByText('Nightly tests')).toBeTruthy()
    expect(screen.getByText('Custom schedule (0 2 * * *) · ' + `next ${new Date(AT).toLocaleString()}`)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\bR2\b|catch_up/)
    expect(screen.getByTestId('last-run').textContent).toBe('Skipped, on schedule — precheck exited 1')
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(await screen.findByText('Started')).toBeTruthy()
    expect(writes[0]).toEqual({ method: 'POST', url: '/api/routines/r1/run' })
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    const list = await screen.findByRole('list', { name: 'History: Nightly tests' })
    expect(list.textContent).toContain('Ran, made up for a missed run')
    expect(list.textContent).toContain('$0.50 · est. $0.40')
  })

  it('Run now that the server skips says why, as a failure-free result', async () => {
    server([routine], [], 'skipped')
    render(<RoutinesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    expect(await screen.findByText('Skipped, by hand — precheck exited 1')).toBeTruthy()
  })

  it('Delete asks first; Cancel keeps the routine', async () => {
    const { writes } = server([routine])
    render(<RoutinesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const ask = screen.getByRole('alertdialog', { name: 'Delete “Nightly tests”? Its history goes too.' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'DELETE', url: '/api/routines/r1' }]))
    expect(await screen.findByText('No routines yet.')).toBeTruthy()
  })

  it('an event routine picks the event in words; a message routine picks an agent from the boards, never a typed id', async () => {
    const { writes } = server([])
    render(<RoutinesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New routine' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ping' } })
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: 'event' } })
    const form = screen.getByRole('form', { name: 'Routine' })
    fireEvent.click(within(form).getAllByRole('button', { name: 'Show suggestions' })[0]!)
    fireEvent.click(screen.getByRole('option', { name: /A file in the workspace changes/ }))
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'outbox' } })
    await waitFor(() => expect(screen.getByRole('option', { name: 'brisk-otter · webterm' })).toBeTruthy())
    expect(screen.queryByRole('option', { name: /zsh/ })).toBeNull() // terminals are not agents
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true) // no agent picked yet
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'n-agent' } })
    fireEvent.submit(form)
    await waitFor(() => expect(writes[0]?.method).toBe('POST'))
    expect(writes[0]!.body).toMatchObject({ trigger: { type: 'event', pattern: 'fs.change' }, action: { type: 'outbox', to: 'n-agent' } })
  })

  it('shows the run estimate next to a skipped run that never spent', async () => {
    server([{ ...routine, lastRun: { ...routine.lastRun!, reason: 'budget: cap', estimateUsd: 2 } }])
    render(<RoutinesPanel />)
    expect((await screen.findByTestId('last-run')).textContent).toBe('Skipped, on schedule — budget: cap · est. $2.00')
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
    // With no routines, the templates are the suggestions under the empty state, each one click away.
    fireEvent.click(within(screen.getByTestId('routines-empty')).getByRole('button', { name: 'Use template: Weekly: find missing tests' }))
    const form = await screen.findByRole('form', { name: 'Routine' })
    expect((screen.getByLabelText('Schedule') as HTMLInputElement).value).toBe('0 9 * * 1')
    expect((screen.getByTestId('routine-more') as HTMLDetailsElement).open).toBe(true) // the template has a check command
    await waitFor(() => expect(screen.getByRole('option', { name: 'webterm' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'w1' } })
    fireEvent.submit(form)
    await waitFor(() => expect(writes[0]?.method).toBe('POST'))
    expect(writes[0]!.body).toMatchObject({ name: 'Weekly: find missing tests', workspaceId: 'w1', enabled: true, precheck: { command: 'true' }, budget: { maxRunsPerDay: 1 } })
    expect(within(await screen.findByTestId('routines-list')).getByText('Weekly: find missing tests', { selector: 'strong' })).toBeTruthy()
  })

  it('a preset schedule shows in plain words; Edit picks another preset and saves its cron', async () => {
    const { writes } = server([{ ...routine, trigger: { type: 'schedule', cron: '0 9 * * 1-5' } }])
    render(<RoutinesPanel />)
    expect(await screen.findByText(/^Weekdays at 9:00/)).toBeTruthy()
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

  it('templates are stacked cards: title, description and a Use template action inside each', async () => {
    server([], [], 'running', [TEMPLATE, { ...TEMPLATE, id: 'second', name: 'Daily summary', description: 'A long description that must wrap inside its card' }])
    render(<RoutinesPanel />)
    const list = await screen.findByRole('list', { name: 'Templates' })
    expect(list.className).toMatch(/\blist-none\b/) // no browser list indent
    expect(list.className).toMatch(/\bp-0\b/)
    const cards = within(list).getAllByRole('listitem')
    expect(cards.map((c) => c.getAttribute('data-template'))).toEqual(['weekly-missing-tests', 'second'])
    const card = cards[1]!
    expect(card.className).toMatch(/\bflex-col\b/) // stacked, never side by side with the button
    expect(within(card).getByText('Daily summary').tagName).toBe('STRONG')
    expect(within(card).getByText('A long description that must wrap inside its card').className).toMatch(/break-words/)
    expect(within(card).getByRole('button', { name: 'Use template: Daily summary' }).textContent).toBe('Use template')
  })

  it('"New routine" is the primary action on the heading row', async () => {
    server([routine])
    render(<RoutinesPanel />)
    const add = await screen.findByRole('button', { name: 'New routine' })
    const heading = screen.getByTestId('routines-heading')
    expect(heading.contains(add)).toBe(true)
    expect(within(heading).getByRole('heading', { name: 'Routines' })).toBeTruthy()
    expect(add.className).toMatch(/\bml-auto\b/)
  })

  it('no routines: a compact empty state with the templates as suggestions under it', async () => {
    server([])
    render(<RoutinesPanel />)
    const empty = await screen.findByTestId('routines-empty')
    expect(within(empty).getByText('No routines yet.')).toBeTruthy()
    const text = empty.textContent ?? ''
    expect(text.indexOf('No routines yet.')).toBeLessThan(text.indexOf('Weekly: find missing tests'))
    expect(screen.queryByTestId('routine-templates-more')).toBeNull()
  })

  it('with routines: the list comes first, the templates collapsed under Templates below it', async () => {
    server([routine])
    render(<RoutinesPanel />)
    const list = await screen.findByTestId('routines-list')
    const more = screen.getByTestId('routine-templates-more') as HTMLDetailsElement
    expect(more.open).toBe(false)
    expect(list.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(more.querySelector('summary')?.textContent).toBe('Templates')
    expect(screen.queryByTestId('routines-empty')).toBeNull()
    expect(list.className).toMatch(/\blist-none\b/)
  })

  it('the intro is one short sentence; the details live in the (i) popover', async () => {
    server([])
    render(<RoutinesPanel />)
    await screen.findByTestId('routines-empty')
    const intro = screen.getByTestId('routines-intro').textContent ?? ''
    expect(intro).toBe('Run an agent on a schedule, on an event, or from a script.')
    expect(document.body.textContent).not.toMatch(/made up by a single run/)
    fireEvent.click(screen.getByRole('button', { name: 'About routines' }))
    const pop = await screen.findByRole('dialog', { name: 'About routines' })
    expect(pop.textContent).toContain('check command')
    expect(pop.textContent).toContain('made up by a single run')
  })

  it('a failed load says so with Retry, which loads again', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/workspaces') return new Response('[]')
      if (fail) return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ routines: [routine], templates: [] }))
    }))
    render(<RoutinesPanel />)
    expect(screen.getByRole('status').textContent).toBe('Loading routines…')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Cannot load routines.')
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Nightly tests')).toBeTruthy()
  })

  it('Save shows Saving… and is disabled while the create is in flight', async () => {
    let release: () => void = () => {}
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/workspaces') return new Response('[]')
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ routines: [], templates: [] }))
      await new Promise<void>((r) => { release = r })
      return new Response('{}', { status: 201 })
    }))
    render(<RoutinesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New routine' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Routine' }))
    const busy = await screen.findByRole('button', { name: 'Saving…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    release()
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Routine' })).toBeNull())
  })
})
