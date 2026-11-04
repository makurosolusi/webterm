/**
 * @vitest-environment jsdom
 */
// Settings › Control › Cost: today/7d totals, cache hit rate, labelled top spenders, paused cap resume, degrade.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COST_API_PATH, COST_TEXT, CostPanel, formatUsd } from './CostPanel'
import type { CostResponse } from '../server/cost/cost.route'
import type { SpendSummary } from '../server/cost/costStore'

// test-only fixtures
const summary = (cost: number, hit: number | null): SpendSummary => ({
  since: 0, costMicros: cost, unpriced: 1, input: 10, output: 10, cacheRead: 30, cacheWrite: 0, cacheHitRate: hit,
  byWorkspace: [{ key: 'w1', costMicros: cost, tokens: 50, responses: 2 }],
  byNode: [{ key: 'n1', costMicros: cost - 100, tokens: 40, responses: 1 }, { key: '', costMicros: 100, tokens: 10, responses: 1 }],
  byModel: [{ key: 'claude-opus-5-5', costMicros: cost, tokens: 50, responses: 2 }],
  byRoutine: [{ key: 'routine:lint', costMicros: 300, tokens: 0, responses: 5 }],
})
const DATA: CostResponse = {
  today: summary(1_250_000, 0.75), week: summary(9_000_000, 0.5),
  caps: [{ scope: 'routine:lint', limitMicros: 0, spentMicros: 300, pausedAt: 1, reason: 'low ROI' }],
  labels: { 'workspace:w1': 'Alpha', 'node:n1': 'Claude in Alpha' },
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
    expect(screen.getByTestId('cost-cache').textContent).toBe('75%')
    expect(screen.getByTestId('cost-prefix').textContent).toBe(COST_TEXT.prefixValue(0.75, 2))
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Claude in Alpha')).toBeTruthy()
    expect(screen.getAllByText(COST_TEXT.central).length).toBeGreaterThan(0)
    expect(screen.getByText(COST_TEXT.unpriced(1))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: COST_TEXT.week }))
    expect(screen.getByTestId('cost-total').textContent).toBe('$9.00')
    expect(screen.getByTestId('cost-cache').textContent).toBe('50%')

    const cap = document.querySelector('[data-scope="routine:lint"]') as HTMLElement
    expect(within(cap).getByText(COST_TEXT.paused)).toBeTruthy()
    fireEvent.click(within(cap).getByRole('button', { name: COST_TEXT.resume }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === `${COST_API_PATH}/resume` && String(i?.body).includes('routine:lint'))).toBe(true))
  })

  it('says the data is unavailable when the ledger is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"ledger_off"}', { status: 503 })))
    render(<CostPanel />)
    expect(await screen.findByText(COST_TEXT.unavailable)).toBeTruthy()
  })

  it('formats sub-cent amounts with four decimals', () => {
    expect(formatUsd(2_500)).toBe('$0.0025')
    expect(formatUsd(0)).toBe('$0.00')
  })
})
