// Health tab transport: project health summary, findings pages, scans and dismiss/reopen.
import type { FindingView, HealthScanView, HealthSummary } from '../../../shared/centralHealth'
import { request } from '../../inboxTransport'
import { InboxApiError } from '../../inboxTypes'
import { CENTRAL_API, centralControlApi } from '../centralControlApi'
import type { FindingFilter } from './healthModel'

const HEALTH_PATH = `${CENTRAL_API}/health`
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** Summary plus whether a scan is running right now. */
export type HealthSummaryView = HealthSummary & { running: boolean }
export interface FindingPage { items: FindingView[]; hasMore: boolean }
/** Deep analysis state: the newest analysis, whether one runs, when the next may start, claims dropped last time. */
export interface AnalysisView { scan: HealthScanView | null; running: boolean; retryAt: number | null; dropped: Record<string, number> | null }

/** What the Health tab needs from the server. */
export interface HealthClient {
  listProjects(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>
  getSummary(projectId: string, signal?: AbortSignal): Promise<HealthSummaryView>
  listFindings(projectId: string, filter: FindingFilter, range: { limit: number; offset: number }, signal?: AbortSignal): Promise<FindingPage>
  scan(projectId: string): Promise<void>
  getAnalysis(projectId: string, signal?: AbortSignal): Promise<AnalysisView>
  analyze(projectId: string): Promise<void>
  dismiss(id: string, reason: string): Promise<FindingView>
  reopen(id: string): Promise<FindingView>
}

const malformed = (what: string): InboxApiError => new InboxApiError(`${what} response malformed`, 502, 'bad_response')
const post = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
const query = (params: Record<string, string | number | undefined>): string =>
  new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString()
const finding = (body: Partial<FindingView> | undefined, what: string): FindingView => {
  if (typeof body?.id !== 'string' || typeof body.status !== 'string') throw malformed(what)
  return body as FindingView
}

/** Default client over the live server. */
export const healthApi: HealthClient = {
  async listProjects(signal) {
    return (await centralControlApi.listBoardNodes(0, undefined, signal)).projects
  },
  async getSummary(projectId, signal) {
    const body = await request<Partial<HealthSummaryView>>(`${HEALTH_PATH}/summary?${query({ projectId })}`, { signal })
    if (typeof body?.open !== 'number') throw malformed('Health summary')
    return { open: body.open, high: body.high ?? 0, medium: body.medium ?? 0, low: body.low ?? 0, lastScan: body.lastScan ?? null, running: body.running === true }
  },
  async listFindings(projectId, filter, { limit, offset }, signal) {
    const params = { projectId, status: filter.status, severity: filter.severity, rule: filter.rule, origin: filter.origin, limit, offset }
    const body = await request<{ items?: FindingView[]; hasMore?: unknown }>(`${HEALTH_PATH}/findings?${query(params)}`, { signal })
    if (!Array.isArray(body?.items)) throw malformed('Finding list')
    // An older server without `hasMore`: a full page means there may be more.
    return { items: body.items, hasMore: typeof body.hasMore === 'boolean' ? body.hasMore : body.items.length >= limit }
  },
  async scan(projectId) {
    await post(`${HEALTH_PATH}/scan`, { projectId })
  },
  async getAnalysis(projectId, signal) {
    const body = await request<Partial<AnalysisView>>(`${HEALTH_PATH}/analyze?${query({ projectId })}`, { signal })
    if (typeof body?.running !== 'boolean') throw malformed('Analysis')
    return { scan: body.scan ?? null, running: body.running, retryAt: typeof body.retryAt === 'number' ? body.retryAt : null, dropped: body.dropped ?? null }
  },
  async analyze(projectId) {
    await post(`${HEALTH_PATH}/analyze`, { projectId })
  },
  async dismiss(id, reason) {
    return finding(await post<Partial<FindingView>>(`${HEALTH_PATH}/findings/${encodeURIComponent(id)}/dismiss`, { reason }), 'Dismiss')
  },
  async reopen(id) {
    return finding(await post<Partial<FindingView>>(`${HEALTH_PATH}/findings/${encodeURIComponent(id)}/reopen`, {}), 'Reopen')
  },
}
