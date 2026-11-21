// `logs.summary` for agents: one compact answer to "why did this page/video fail". Counts per level/channel,
// page failures grouped by (category, host, status) with a plain-language hint, and the server events
// (browser.ssrf.*, browser.launch*) of the same time window, linked to the failures they explain.
import type { LogEntry } from '../../shared/logEntry'
import { hintFor } from './logHints'
import type { PageFailure } from './logHints'
import { parseSince, visibleTo } from './logAgentQuery'
import type { AgentLogScope } from './logAgentQuery'

export const SUMMARY_DEFAULT_SINCE_MS = 10 * 60_000
const MAX_GROUPS = 15
const MAX_CHANNELS = 15
const MAX_SERVER_EVENTS = 10
const PAGE_CHANNEL = 'browser.page'
const SERVER_EVENT = /^browser\.(ssrf\.|launch)/

export interface SummaryParams { node?: string; since?: string }

export interface PageFailureGroup {
  nodeId?: string; category: string; host: string; status?: number; path: string; kind: string
  count: number; firstTs: string; lastTs: string; hint?: string
  /** Server events (e.g. browser.ssrf.block) that name the same host. */
  serverEvents?: string[]
}
export interface ServerEventGroup { event: string; count: number; hostname?: string; reason?: string; lastTs: string }
export interface LogSummary {
  windowMs: number; node?: string; total: number
  byLevel: Record<string, number>; byChannel: Array<{ channel: string; count: number }>
  pageFailures: PageFailureGroup[]; serverEvents: ServerEventGroup[]
  /** Hints of the failure groups, most frequent first, deduplicated: read this first. */
  diagnosis: string[]
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const iso = (ms: number): string => new Date(ms).toISOString()

/** Summary of `entries` (bus snapshot) visible to `scope`, over the last `since` (default 10m), optionally for one node. */
export function summarizeLogs(entries: readonly LogEntry[], params: SummaryParams, scope: AgentLogScope, now: number): LogSummary {
  const windowMs = parseSince(params.since) ?? SUMMARY_DEFAULT_SINCE_MS
  const inWindow = entries.filter((e) => e.ts >= now - windowMs && visibleTo(e, scope))
  const mine = params.node ? inWindow.filter((e) => e.ids?.nodeId === params.node || (!e.ids?.nodeId && SERVER_EVENT.test(e.event))) : inWindow

  const byLevel: Record<string, number> = {}
  const byChannel = new Map<string, number>()
  for (const e of mine) {
    byLevel[e.level] = (byLevel[e.level] ?? 0) + 1
    byChannel.set(e.channel, (byChannel.get(e.channel) ?? 0) + 1)
  }

  const groups = new Map<string, PageFailureGroup & { key: string }>()
  for (const e of mine.filter((x) => x.channel === PAGE_CHANNEL)) {
    const d = e.data ?? {}
    const category = str(d.category) ?? e.event
    const host = str(d.host) ?? ''
    const status = typeof d.status === 'number' ? d.status : undefined
    const key = `${e.ids?.nodeId ?? ''}|${category}|${host}|${status ?? ''}|${str(d.sig) ?? ''}`
    const count = num(d.count, 1)
    const g = groups.get(key)
    if (g) { g.count = Math.max(g.count, count); g.lastTs = iso(num(d.lastTs, e.ts)) } else {
      groups.set(key, {
        key, ...(e.ids?.nodeId ? { nodeId: e.ids.nodeId } : {}), category, host, ...(status ? { status } : {}), path: str(d.path) ?? '',
        kind: str(d.kind) ?? 'console', count, firstTs: iso(num(d.firstTs, e.ts)), lastTs: iso(num(d.lastTs, e.ts)),
      })
    }
  }

  const server = new Map<string, ServerEventGroup>()
  for (const e of inWindow.filter((x) => SERVER_EVENT.test(x.event))) {
    const hostname = str(e.data?.hostname)
    const reason = str(e.data?.reason) ?? str(e.data?.cause)
    const key = `${e.event}|${hostname ?? ''}|${reason ?? ''}`
    const g = server.get(key)
    if (g) { g.count++; g.lastTs = iso(e.ts) } else server.set(key, { event: e.event, count: 1, ...(hostname ? { hostname } : {}), ...(reason ? { reason } : {}), lastTs: iso(e.ts) })
  }
  const serverEvents = [...server.values()].sort((a, b) => b.count - a.count).slice(0, MAX_SERVER_EVENTS)

  const pageFailures = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_GROUPS).map(({ key: _key, ...g }) => {
    const hint = hintFor({ kind: g.kind as PageFailure['kind'], category: g.category, host: g.host, status: g.status, path: g.path, sig: '' })
    const related = serverEvents.filter((s) => s.hostname && g.host && (g.host === s.hostname || g.host.endsWith(`.${s.hostname}`)))
      .map((s) => `${s.event}${s.reason ? ` (${s.reason})` : ''} x${s.count}`)
    return { ...g, ...(hint ? { hint } : {}), ...(related.length ? { serverEvents: related } : {}) }
  })

  const diagnosis = [...new Set(pageFailures.flatMap((g) => (g.hint ? [`${g.category} ${g.host}${g.status ? ` ${g.status}` : ''} x${g.count}: ${g.hint}`] : [])))]
  return {
    windowMs, ...(params.node ? { node: params.node } : {}), total: mine.length, byLevel,
    byChannel: [...byChannel].map(([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count).slice(0, MAX_CHANNELS),
    pageFailures, serverEvents, diagnosis,
  }
}
