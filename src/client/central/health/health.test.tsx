/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError } from '../../inboxTypes'
import { knownTab } from '../CentralControlPanel'
import { shimRadixSelect } from '../work/taskBoardFixtures.testutil'
import HealthView from './HealthView'
import { expand, findingOf, makeClient, scanOf, summaryOf } from './health.fixtures.testutil'
import { healthApi, type AnalysisView } from './healthApi'
import { HL, SCAN_POLL_MS } from './healthModel'

beforeAll(shimRadixSelect)
beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

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

  it('shows the one-row summary, partial badge and a one-line row whose details expand', async () => {
    render(<HealthView client={makeClient({ getSummary: vi.fn(async () => summaryOf({ lastScan: scanOf({ truncated: true }) })) })} />)
    const toggle = await screen.findByRole('button', { name: HL.details('File too large') })
    expect(screen.getByText(/^1 open · scanned .+ · 42 files$/)).toBeTruthy()
    expect(screen.getByText(HL.partial)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'big.ts:12' })).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('612 lines')).toBeNull()
    expect(screen.queryByText(/Rule 8/)).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('612 lines')).toBeTruthy()
    expect(screen.getByText(/Rule 8 \(global CLAUDE.md\) · High confidence/)).toBeTruthy()
    expect(screen.getByText('Split it by concern.')).toBeTruthy()
    expect(screen.getByText(/First seen/)).toBeTruthy()
    expect(screen.queryByText(HL.verifyFirst)).toBeNull()
  })

  it('hints to verify a medium-confidence finding in its details', async () => {
    render(<HealthView client={makeClient({ listFindings: vi.fn(async () => ({ items: [findingOf({ confidence: 'medium' })], hasMore: false })) })} />)
    await expand()
    expect(screen.getByText(HL.verifyFirst)).toBeTruthy()
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
    expect(await screen.findByRole('button', { name: HL.details('File too large') })).toBeTruthy()
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

const analysisOf = (over: Partial<AnalysisView> = {}): AnalysisView => ({ scan: null, running: false, retryAt: null, dropped: null, ...over })

describe('Health deep analysis', () => {
  it('Scan now and Deep analysis are buttons side by side; the cost note sits behind (i)', async () => {
    let finish: () => void = () => undefined
    const client = makeClient({ analyze: vi.fn(() => new Promise<void>((r) => { finish = r })) })
    render(<HealthView client={client} />)
    const analyze = await screen.findByRole('button', { name: HL.analyze })
    expect(analyze.getAttribute('data-slot')).toBe('button')
    expect(analyze.parentElement?.parentElement).toBe(screen.getByRole('button', { name: HL.scanNow }).parentElement)
    expect(screen.queryByText(HL.analyzeCost)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: HL.about }))
    expect(screen.getByRole('note').textContent).toContain(HL.analyzeCost)
    fireEvent.click(analyze)
    const busy = await screen.findByRole('button', { name: HL.analyzing })
    expect([busy.getAttribute('aria-busy'), (busy as HTMLButtonElement).disabled]).toEqual(['true', true])
    expect(client.analyze).toHaveBeenCalledWith('p1')
    await act(async () => finish())
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

  it('analysis findings explain the verified quote in their details', async () => {
    render(<HealthView client={makeClient({ listFindings: vi.fn(async () => ({ items: [findingOf({ origin: 'analysis', rule: 'analysis', confidence: 'medium' })], hasMore: false })) })} />)
    await expand()
    expect(screen.getByText(HL.verifiedQuote)).toBeTruthy()
    expect(screen.getByText(HL.verifiedQuoteHint)).toBeTruthy()
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

  it('lists projects with the folder the board-nodes route returns, without reading workspaces', async () => {
    const projects = [{ id: 'p1', name: 'Alpha', workspaceId: 'w1', cwd: '/a' }, { id: 'p2', name: 'NoFolder', workspaceId: 'w2', cwd: null }, { id: 'p3', name: 'Older server' }]
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [], projects }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await healthApi.listProjects()).toEqual([{ id: 'p1', name: 'Alpha', root: '/a' }, { id: 'p2', name: 'NoFolder' }, { id: 'p3', name: 'Older server' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^\/api\/central\/nodes\?/)
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
