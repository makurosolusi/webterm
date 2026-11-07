// Klien REST untuk Agent History (`src/server/sessionHistory.route.ts`). Token hanya di header.
import type { ClosedEntry } from './closedHistory'

/** Agent History lists Claude Code sessions only (the server hides older codex rows). */
export type HistoryAgent = 'claude'

/** Satu sesi agent yang terindeks dari transcript di disk. */
export interface AgentSession {
  agent: HistoryAgent
  id: string
  cwd: string | null
  title: string | null
  startedAt: number | null
  endedAt: number | null
  messageCount: number
}

export interface AgentSessionPage {
  items: AgentSession[]
  total: number
  nextOffset: number | null
}

async function call<T>(url: string, init?: { method: string; body: unknown }): Promise<T | undefined> {
  const headers: Record<string, string> = {}
  if (init) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, init ? { method: init.method, headers, body: JSON.stringify(init.body) } : { headers })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url.split('?')[0]} -> ${res.status}`)
  return res.status === 204 ? undefined : ((await res.json()) as T)
}

/** Halaman sesi. `cwd` kosong = semua sesi di mesin ini. */
export async function fetchSessionPage(opts: {
  cwd?: string; q?: string; offset?: number; limit?: number; refresh?: boolean
}): Promise<AgentSessionPage> {
  const p = new URLSearchParams()
  if (opts.cwd) p.set('cwd', opts.cwd)
  if (opts.q?.trim()) p.set('q', opts.q.trim())
  if (opts.offset) p.set('offset', String(opts.offset))
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.refresh) p.set('refresh', '1')
  const page = await call<AgentSessionPage>(`/api/session-history?${p}`)
  return page ?? { items: [], total: 0, nextOffset: null }
}

export async function fetchClosedHistory(): Promise<ClosedEntry[]> {
  const r = await call<{ entries: ClosedEntry[] }>('/api/closed-history')
  return r?.entries ?? []
}

export async function saveClosedHistory(entries: readonly ClosedEntry[]): Promise<void> {
  await call('/api/closed-history', { method: 'PUT', body: { entries } })
}
