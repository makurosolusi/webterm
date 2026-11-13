/**
 * @vitest-environment jsdom
 */
// Control › Spending: today/7d totals, labelled top spenders, paused cap resume with its real error, degrade;
// Settings › Developer's CostDetails: cache hit rate, prefix reuse, pricing.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COST_API_PATH, COST_TEXT, CostDetails, CostPanel, formatUsd, modelName, scopeName } from './CostPanel'
import { OPEN_SETTINGS_EVENT } from './settings.link'
import type { CostResponse } from '../server/cost/cost.route'
import type { SpendSummary } from '../server/cost/costStore'

// test-only fixtures
const summary = (cost: number, hit: number | null): SpendSummary => ({
  since: 0, costMicros: cost, unpriced: 1, input: 10, output: 10, cacheRead: 30, cacheWrite: 0, cacheHitRate: hit,
  byWorkspace: [{ key: 'w1', costMicros: cost - 100, tokens: 40, responses: 1 }, { key: '', costMicros: 100, tokens: 10, responses: 1 }],
  byNode: [
    { key: 'n1', costMicros: cost / 4, tokens: 40, responses: 1 },
    { key: 'c-ag-9f3e21aa', costMicros: 500, tokens: 1, responses: 1 },
    { key: '', costMicros: 100, tokens: 10, responses: 1 },
  ],
  byModel: [{ key: 'claude-opus-5-5', costMicros: cost, tokens: 50, responses: 2 }],
  byRoutine: [{ key: 'routine:lint', costMicros: 300, tokens: 0, responses: 5 }],
})
const DATA: CostResponse = {
  today: summary(1_250_000, 0.75), week: summary(9_000_000, 0.5),
  caps: [{ scope: 'routine:lint', limitMicros: 0, spentMicros: 300, pausedAt: 1, reason: 'low ROI' }],
  labels: { 'workspace:w1': 'Alpha', 'node:n1': 'Claude in Alpha', 'node:c-ag-9f3e21aa': 'Node c-ag-9f3' },
  pricing: { source: 'https://platform.claude.com/docs/en/about-claude/pricing', checkedAt: '2026-11-04' },
  prefix: { prefixes: 2, hits: 6, reuseRate: 0.75 },
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('CostPanel', () => {
  it('renders today, switches to 7 days, labels spenders and resumes a paused routine', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === COST_API_PATH) return new Response(JSON.stringify(DATA), { status: 200 })
      if (url === `${COST_API_PATH}/resume` && init?.method === 'POST') return new Response('{"ok":true}', { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CostPanel />)
    expect(await screen.findByTestId('cost-total')).toHaveProperty('textContent', '$1.25')
    // The Control › Spending tab names it; the panel itself has no second "Spending" heading.
    expect(screen.queryByRole('heading', { name: COST_TEXT.title })).toBeNull()
    expect(screen.getByRole('region', { name: COST_TEXT.title })).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Claude in Alpha')).toBeTruthy()
    expect(screen.getAllByText(COST_TEXT.central).length).toBeGreaterThan(0)

    expect(screen.getByRole('radio', { name: COST_TEXT.today }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: COST_TEXT.week }))
    expect(screen.getByRole('radio', { name: COST_TEXT.week }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('cost-total').textContent).toBe('$9.00')

    const cap = document.querySelector('[data-scope="routine:lint"]') as HTMLElement
    expect(within(cap).getByText(COST_TEXT.paused)).toBeTruthy()
    fireEvent.click(within(cap).getByRole('button', { name: COST_TEXT.resume }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === `${COST_API_PATH}/resume` && String(i?.body).includes('routine:lint'))).toBe(true))
  })

  it('names scopes in plain words, has no second limit of its own, and links to the one daily limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...DATA, caps: [...DATA.caps, { scope: 'day', limitMicros: 5_000_000, spentMicros: 0, pausedAt: null, reason: null }] }))))
    render(<CostPanel />)
    await screen.findByTestId('cost-total')
    expect(within(document.querySelector('[data-scope="routine:lint"]') as HTMLElement).getByText('Routine lint')).toBeTruthy()
    expect(within(document.querySelector('[data-scope="day"]') as HTMLElement).getByText('All work today')).toBeTruthy()
    expect(screen.queryByText('routine:lint')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull() // the old "Pause all work at $" cap is gone
    expect(screen.queryByTestId('cost-cache')).toBeNull() // details live in Settings › Developer
    const opened: unknown[] = []
    const on = (e: Event): void => { opened.push((e as CustomEvent).detail) }
    window.addEventListener(OPEN_SETTINGS_EVENT, on)
    fireEvent.click(screen.getByRole('button', { name: COST_TEXT.limitLink }))
    window.removeEventListener(OPEN_SETTINGS_EVENT, on)
    expect(opened).toEqual([{ section: 'central', field: 'central.costLimit' }])
  })

  it('a failed Resume shows the server reason and keeps the report', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === COST_API_PATH && !init?.method || init?.method === 'GET'
      ? new Response(JSON.stringify(DATA))
      : new Response(JSON.stringify({ error: 'invalid_scope' }), { status: 400 }))))
    render(<CostPanel />)
    fireEvent.click(await screen.findByRole('button', { name: COST_TEXT.resume }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Could not resume: .*invalid_scope/)
    expect(screen.queryByText(COST_TEXT.unavailable)).toBeNull()
    expect(screen.getByTestId('cost-total')).toBeTruthy()
  })

  it('CostDetails shows the 7-day cache hit rate, prefix reuse, unpriced count and the price source', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DATA))))
    render(<CostDetails />)
    expect((await screen.findByTestId('cost-cache')).textContent).toBe('50%')
    expect(screen.getByTestId('cost-prefix').textContent).toBe(COST_TEXT.prefixValue(0.75, 2))
    expect(screen.getByText(COST_TEXT.unpriced(1))).toBeTruthy()
    expect(screen.getByTestId('cost-details').textContent).toContain(COST_TEXT.pricing)
  })

  it('scopeName maps raw keys to plain names', () => {
    expect(scopeName('routine:docs')).toBe('Routine docs')
    expect(scopeName('dag:g1')).toBe('Plan g1')
    expect(scopeName('central')).toBe('Central Agent')
    expect(scopeName('')).toBe('Central Agent')
    expect(scopeName('mystery:x')).toBe('mystery:x')
  })

  it('says the data is unavailable when the ledger is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"ledger_off"}', { status: 503 })))
    render(<CostPanel />)
    expect(await screen.findByText(COST_TEXT.unavailable)).toBeTruthy()
  })

  it('formats money one way: two decimals, "<$0.01" below a cent', () => {
    expect(formatUsd(2_500)).toBe('<$0.01')
    expect(formatUsd(9_999)).toBe('<$0.01')
    expect(formatUsd(10_000)).toBe('$0.01')
    expect(formatUsd(15_050_000)).toBe('$15.05')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('names models in plain words', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelName('claude-haiku-5-5-20261001')).toBe('Haiku 5.5')
    expect(modelName('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelName('gpt-x')).toBe('gpt-x')
  })

  it('lays out one column when narrow, friendly names, Central once, share bars and a sub-cent row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DATA))))
    render(<CostPanel />)
    await screen.findByTestId('cost-total')
    const groups = screen.getByTestId('cost-groups')
    expect(groups.className).toMatch(/(^|\s)grid-cols-1(\s|$)/)
    expect(groups.className).toContain('@xl:grid-cols-2')
    expect(groups.parentElement?.className).toContain('@container')
    for (const ul of document.querySelectorAll('ul')) expect(ul.className).toMatch(/list-none.*p-0|p-0.*list-none/)

    expect(screen.getByText('Opus 5.5')).toBeTruthy()
    expect(screen.queryByText('claude-opus-5-5')).toBeNull()
    expect(screen.getByText(COST_TEXT.deletedNode)).toBeTruthy()
    expect(screen.queryByText(/c-ag-9/)).toBeNull()
    expect(screen.getAllByText(COST_TEXT.central)).toHaveLength(1) // By workspace only, not again in Top spenders
    expect(document.querySelectorAll('[data-key=""]')).toHaveLength(1)

    const spender = screen.getByText('Claude in Alpha').closest('li') as HTMLElement
    expect((within(spender).getByTestId('share-bar') as HTMLElement).style.width).toBe('25%')
    expect(within(spender).getByRole('img', { name: COST_TEXT.share(25) })).toBeTruthy()
    const gone = screen.getByText(COST_TEXT.deletedNode).closest('li') as HTMLElement
    expect(within(gone).getByText('<$0.01')).toBeTruthy()
    expect((within(gone).getByTestId('share-bar') as HTMLElement).style.width).toBe('0%')
    expect(screen.getByTestId('cost-responses').textContent).toBe('2')
  })

  it('the period is one radio group: a single tab stop, arrow keys move focus, Enter/Space select', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DATA))))
    render(<CostPanel />)
    await screen.findByTestId('cost-total')
    const group = screen.getByRole('radiogroup', { name: COST_TEXT.period })
    const [today, week] = within(group).getAllByRole('radio')
    expect([today!.tabIndex, week!.tabIndex]).toEqual([0, -1])
    act(() => today!.focus())
    fireEvent.keyDown(today!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(week)
    expect([today!.tabIndex, week!.tabIndex]).toEqual([-1, 0])
    expect(today!.getAttribute('aria-checked')).toBe('true') // focus moved, the choice did not
    fireEvent.keyDown(week!, { key: 'Enter' })
    expect(week!.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('cost-total').textContent).toBe('$9.00')
    fireEvent.keyDown(week!, { key: 'ArrowRight' }) // wraps
    expect(document.activeElement).toBe(today)
    fireEvent.keyDown(today!, { key: ' ' })
    expect(today!.getAttribute('aria-checked')).toBe('true')
  })
})
