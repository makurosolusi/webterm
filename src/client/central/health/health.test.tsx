/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { FindingView, HealthScanView } from '../../../shared/centralHealth'
import { InboxApiError } from '../../inboxTypes'
import { knownTab } from '../CentralControlPanel'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { shimRadixSelect } from '../work/taskBoardFixtures.testutil'
import HealthView from './HealthView'
import { healthApi, type AnalysisView, type HealthClient, type HealthSummaryView } from './healthApi'
import { HL, SCAN_POLL_MS } from './healthModel'

beforeAll(shimRadixSelect)
beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

// test-only fixtures
const scanOf = (over: Partial<HealthScanView> = {}): HealthScanView => ({
  id: 's1', projectId: 'p1', origin: 'scan', status: 'done', startedAt: Date.now() - 60_000, finishedAt: Date.now() - 60_000, filesScanned: 42, truncated: false, opened: 1, fixed: 0, error: null, ...over,
})
const summaryOf = (over: Partial<HealthSummaryView> = {}): HealthSummaryView => ({ open: 1, high: 1, medium: 0, low: 0, lastScan: scanOf(), running: false, ...over })
const findingOf = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'f1', projectId: 'p1', origin: 'scan', status: 'open', rule: 'file_size', severity: 'high', confidence: 'high', file: 'src/big.ts', line: 12,
  title: 'File too large', evidence: '612 lines', source: 'Rule 8 (global CLAUDE.md)', suggestion: 'Split it by concern.', fingerprint: 'fp',
  taskId: null, dismissedReason: null, dismissedBy: null, firstSeenAt: 1, lastSeenAt: 2, fixedAt: null, ...over,
})

function makeClient(over: Partial<HealthClient> = {}) {
  const client = {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'Alpha' }]),
    getSummary: vi.fn(async () => summaryOf()),
    listFindings: vi.fn(async () => ({ items: [findingOf()], hasMore: false })),
    scan: vi.fn(async () => undefined),
    dismiss: vi.fn(async (id: string, reason: string) => findingOf({ id, status: 'dismissed', dismissedReason: reason })),
    reopen: vi.fn(async (id: string) => findingOf({ id })),
    getAnalysis: vi.fn(async (): Promise<AnalysisView> => ({ scan: null, running: false, retryAt: null, dropped: null })),
    analyze: vi.fn(async () => undefined),
    ...over,
  }
  return client as unknown as { [K in keyof HealthClient]: Mock<HealthClient[K]> }
}

describe('Health tab states', () => {
  it('is a known tab', () => expect(knownTab('health')).toBe('health'))

  it('shows loading before data', () => {
    render(<HealthView client={makeClient({ listProjects: vi.fn(() => new Promise<never>(() => undefined)) })} />)
    expect(screen.getByRole('status').textContent).toBe(HL.loading)
  })

  it('says when there are no projects', async () => {
    render(<HealthView client={makeClient({ listProjects: vi.fn(async () => []) })} />)
    expect(await screen.findByText(HL.noProjects)).toBeTruthy()
  })

  it('shows counts, last scan, partial badge and findings with evidence', async () => {
    render(<HealthView client={makeClient({ getSummary: vi.fn(async () => summaryOf({ lastScan: scanOf({ truncated: true }) })) })} />)
    expect(await screen.findByText('612 lines')).toBeTruthy()
    expect(screen.getByText(HL.counts(1))).toBeTruthy()
    expect(screen.getByText(/Last scan .* 42 files/)).toBeTruthy()
    expect(screen.getByText(HL.partial)).toBeTruthy()
    expect(screen.getByText('src/big.ts:12')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy src/big.ts:12' })).toBeTruthy()
    expect(screen.getByText(/Rule 8 \(global CLAUDE.md\)/)).toBeTruthy()
    expect(screen.queryByText(HL.verifyFirst)).toBeNull()
  })

  it('hints to verify a medium-confidence finding and expands details', async () => {
    render(<HealthView client={makeClient({ listFindings: vi.fn(async () => ({ items: [findingOf({ confidence: 'medium' })], hasMore: false })) })} />)
    expect(await screen.findByText(HL.verifyFirst)).toBeTruthy()
    const toggle = screen.getByRole('button', { name: HL.details('File too large') })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/First seen/)).toBeTruthy()
  })

  it('says no findings with the last scan time', async () => {
    render(<HealthView client={makeClient({ listFindings: vi.fn(async () => ({ items: [], hasMore: false })) })} />)
    expect(await screen.findByText(/^No findings\. Last scan .+\.$/)).toBeTruthy()
  })

  it('offers Run a scan when never scanned', async () => {
    const client = makeClient({ getSummary: vi.fn(async () => summaryOf({ open: 0, high: 0, lastScan: null })) })
    render(<HealthView client={client} />)
    const cta = await screen.findByRole('button', { name: HL.runScan })
    expect(screen.getByText(HL.neverScanned)).toBeTruthy()
    expect(client.listFindings).not.toHaveBeenCalled()
    fireEvent.click(cta)
    await waitFor(() => expect(client.scan).toHaveBeenCalledWith('p1'))
  })

  it('shows a failed scan with its error, and a missing repo folder in words', async () => {
    const getSummary = vi.fn(async () => summaryOf({ lastScan: scanOf({ status: 'failed', error: 'deadline exceeded' }) }))
    render(<HealthView client={makeClient({ getSummary })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(HL.lastScanFailed('deadline exceeded'))
    cleanup()
    getSummary.mockResolvedValue(summaryOf({ lastScan: scanOf({ status: 'failed', error: 'project p1 has no repository folder to scan' }) }))
    render(<HealthView client={makeClient({ getSummary })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(HL.noRepo)
  })

  it('shows a fetch error with Retry that reloads', async () => {
    const getSummary = vi.fn().mockRejectedValue(new InboxApiError('GET failed', 500, 'boom'))
    render(<HealthView client={makeClient({ getSummary })} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    getSummary.mockResolvedValue(summaryOf())
    fireEvent.click(screen.getByRole('button', { name: HL.retry }))
    expect(await screen.findByText('612 lines')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the off state when Central routes do not answer', async () => {
    render(<HealthView client={makeClient({ getSummary: vi.fn().mockRejectedValue(new InboxApiError('off', 404, 'http_404')) })} />)
    expect(await screen.findByText(HL.off)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when the project is gone', async () => {
    render(<HealthView client={makeClient({ getSummary: vi.fn().mockRejectedValue(new InboxApiError('gone', 404, 'project_not_found')) })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(HL.gone)
  })
})

describe('Health scan', () => {
  it('disables Scan now while running, polls, and reloads findings when done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const getSummary = vi.fn(async () => summaryOf({ running: true, lastScan: scanOf({ status: 'running', finishedAt: null }) }))
    const client = makeClient({ getSummary })
    render(<HealthView client={client} />)
    const button = await screen.findByRole('button', { name: HL.scanning })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    const calls = client.listFindings.mock.calls.length
    getSummary.mockResolvedValue(summaryOf())
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS) })
    await waitFor(() => expect((screen.getByRole('button', { name: HL.scanNow }) as HTMLButtonElement).disabled).toBe(false))
    await waitFor(() => expect(client.listFindings.mock.calls.length).toBeGreaterThan(calls))
  })

  it('treats 409 scan_running as running, not an error', async () => {
    const client = makeClient({ scan: vi.fn().mockRejectedValue(new InboxApiError('busy', 409, 'scan_running')) })
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.scanNow }))
    await waitFor(() => expect(client.getSummary).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(HL.scanFailed)).toBeNull()
  })
})

describe('Health filters, dismiss and pages', () => {
  it('status and severity buttons change the query', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    await screen.findByText('612 lines')
    fireEvent.click(within(screen.getByRole('group', { name: HL.statusLabel })).getByRole('button', { name: 'Dismissed' }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'dismissed' }, { limit: CENTRAL_PAGE_SIZE, offset: 0 }, expect.anything()))
    fireEvent.click(within(screen.getByRole('group', { name: HL.severityLabel })).getByRole('button', { name: 'High' }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'dismissed', severity: 'high' }, expect.anything(), expect.anything()))
    expect(within(screen.getByRole('group', { name: HL.severityLabel })).getByRole('button', { name: 'High' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('rule select changes the query', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    await screen.findByText('612 lines')
    fireEvent.keyDown(screen.getByRole('combobox', { name: HL.ruleLabel }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'Empty catch' }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open', rule: 'empty_catch' }, expect.anything(), expect.anything()))
  })

  it('dismiss needs a reason and sends preset plus note', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.dismissLabel('File too large') }))
    const form = screen.getByRole('group', { name: HL.dismissLabel('File too large') })
    const confirm = within(form).getByRole('button', { name: HL.dismissConfirm })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(form).getByRole('button', { name: 'False positive' }))
    fireEvent.change(within(form).getByRole('textbox', { name: HL.dismissNote }), { target: { value: 'generated file' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(client.dismiss).toHaveBeenCalledWith('f1', 'False positive: generated file'))
    expect(await screen.findByText('Dismissed: False positive: generated file')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: HL.reopenLabel('File too large') }))
    await waitFor(() => expect(client.reopen).toHaveBeenCalledWith('f1'))
  })

  it('offers Load more on a full page and asks for the next offset', async () => {
    const items = Array.from({ length: CENTRAL_PAGE_SIZE }, (_, i) => findingOf({ id: `f${i}`, title: `Finding ${i}` }))
    const client = makeClient({ listFindings: vi.fn(async () => ({ items, hasMore: true })) })
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.loadMore }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open' }, { limit: CENTRAL_PAGE_SIZE, offset: CENTRAL_PAGE_SIZE }, expect.anything()))
  })
})

const analysisOf = (over: Partial<AnalysisView> = {}): AnalysisView => ({ scan: null, running: false, retryAt: null, dropped: null, ...over })

describe('Health deep analysis', () => {
  it('offers Deep analysis with its cost note and starts it', async () => {
    const client = makeClient()
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.analyze }))
    expect(screen.getByText(HL.analyzeCost)).toBeTruthy()
    await waitFor(() => expect(client.analyze).toHaveBeenCalledWith('p1'))
  })

  it('shows running, then reloads findings and summary when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const getAnalysis = vi.fn(async () => analysisOf({ running: true, scan: scanOf({ origin: 'analysis', status: 'running', finishedAt: null }) }))
    const client = makeClient({ getAnalysis })
    render(<HealthView client={client} />)
    expect(((await screen.findByRole('button', { name: HL.analyzing })) as HTMLButtonElement).disabled).toBe(true)
    const lists = client.listFindings.mock.calls.length
    const summaries = client.getSummary.mock.calls.length
    getAnalysis.mockResolvedValue(analysisOf({ scan: scanOf({ origin: 'analysis', opened: 3 }), retryAt: Date.now() + 3_600_000, dropped: { quote_not_found: 2 } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(SCAN_POLL_MS) })
    expect(await screen.findByText(/Last analysis .* 3 new · 2 unverified claims dropped/)).toBeTruthy()
    await waitFor(() => expect(client.listFindings.mock.calls.length).toBeGreaterThan(lists))
    expect(client.getSummary.mock.calls.length).toBeGreaterThan(summaries)
  })

  it('disables the button during the cooldown and says when it is available', async () => {
    render(<HealthView client={makeClient({ getAnalysis: vi.fn(async () => analysisOf({ retryAt: Date.now() + 1_800_000 })) })} />)
    expect(((await screen.findByRole('button', { name: HL.analyze })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/^Available again at /)).toBeTruthy()
  })

  it('shows a failed analysis with its error', async () => {
    render(<HealthView client={makeClient({ getAnalysis: vi.fn(async () => analysisOf({ scan: scanOf({ origin: 'analysis', status: 'failed', error: 'analysis failed: claude exited 1' }) })) })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(HL.lastAnalysisFailed('analysis failed: claude exited 1'))
  })

  it('treats 429 cooldown as state, not an error; other failures say so', async () => {
    const analyze = vi.fn().mockRejectedValue(new InboxApiError('slow down', 429, 'cooldown'))
    const client = makeClient({ analyze })
    render(<HealthView client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: HL.analyze }))
    await waitFor(() => expect(client.getAnalysis).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
    analyze.mockRejectedValue(new InboxApiError('boom', 500, 'internal_error'))
    fireEvent.click(await screen.findByRole('button', { name: HL.analyze }))
    expect((await screen.findByRole('alert')).textContent).toBe(HL.analyzeFailed)
  })

  it('origin buttons filter the list; analysis findings carry a Verified quote badge', async () => {
    const client = makeClient({ listFindings: vi.fn(async () => ({ items: [findingOf({ origin: 'analysis', rule: 'analysis', confidence: 'medium' })], hasMore: false })) })
    render(<HealthView client={client} />)
    expect(await screen.findByText(HL.verifiedQuote)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('group', { name: HL.originLabel })).getByRole('button', { name: 'Analysis' }))
    await waitFor(() => expect(client.listFindings).toHaveBeenLastCalledWith('p1', { status: 'open', origin: 'analysis' }, expect.anything(), expect.anything()))
  })
})

describe('healthApi', () => {
  it('reads and starts the analysis and sends the origin filter', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ scan: null, running: false, retryAt: 5, dropped: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await healthApi.getAnalysis('p1')).toEqual({ scan: null, running: false, retryAt: 5, dropped: null })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/central/health/analyze?projectId=p1')
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 's' }), { status: 202 }))
    await healthApi.analyze('p1')
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect([url, init.method, init.body]).toEqual(['/api/central/health/analyze', 'POST', JSON.stringify({ projectId: 'p1' })])
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }))
    await healthApi.listFindings('p1', { status: 'open', origin: 'review' }, { limit: 50, offset: 0 })
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/central/health/findings?projectId=p1&status=open&origin=review&limit=50&offset=0')
  })

  it('builds the findings query and posts a dismiss reason', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await healthApi.listFindings('p1', { status: 'open', severity: 'high', rule: 'empty_catch' }, { limit: 50, offset: 50 })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/central/health/findings?projectId=p1&status=open&severity=high&rule=empty_catch&limit=50&offset=50')
    fetchMock.mockResolvedValue(new Response(JSON.stringify(findingOf({ status: 'dismissed' })), { status: 200 }))
    await healthApi.dismiss('f/1', 'Intentional')
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect([url, init.method, init.body]).toEqual(['/api/central/health/findings/f%2F1/dismiss', 'POST', JSON.stringify({ reason: 'Intentional' })])
  })
})
