// Older-history page for the Activity timeline (client `Timeline*`). The SSE stream only replays
// forward from a cursor; a timeline opens on the NEWEST page and walks backwards, like VS Code's
// sessions list and Devin's Progress tab load recent first.
//   GET /api/events/history[?beforeSeq=<n>&limit=<n>]  -> { events (ascending), more }
// Root token / same-origin UI only, like the rest of /api/events (not in `isNodeTokenPath`).
import type { Database } from 'bun:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { allRows } from '../ledger/ledgerCore'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import type { EventLog } from './eventLog'
import { EVENTS_PATH } from './eventsApi'
import { activeEventsRuntime } from './eventsRuntime'

export const HISTORY_PATH = `${EVENTS_PATH}/history`
export const HISTORY_DEFAULT_LIMIT = 100
export const HISTORY_MAX_LIMIT = 500

export interface HistoryDeps { db: Database; log: EventLog }

function activeDeps(): HistoryDeps | null {
  const rt = activeEventsRuntime()
  const ledger = activeLedgerRuntime()
  return rt && ledger ? { db: ledger.db, log: rt.log } : null
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const intParam = (raw: string | null): number | undefined | null =>
  raw === null || raw === '' ? undefined : /^\d{1,15}$/.test(raw) ? Number(raw) : null

/** The `limit` chained rows just below `beforeSeq` (or the newest), oldest first. */
export function historyPage(deps: HistoryDeps, beforeSeq: number | undefined, limit: number): { events: ReturnType<EventLog['list']>; more: boolean } {
  const before = beforeSeq ?? Number.MAX_SAFE_INTEGER
  // One extra seq tells whether an older page exists without a second COUNT query.
  const seqs = allRows(deps.db, 'SELECT seq FROM event WHERE hash IS NOT NULL AND seq < ? ORDER BY seq DESC LIMIT ?', before, limit + 1).map((r) => Number(r['seq']))
  const more = seqs.length > limit
  const page = seqs.slice(0, limit)
  if (page.length === 0) return { events: [], more: false }
  const lowest = page[page.length - 1]!
  return { events: deps.log.list(lowest - 1, page.length).filter((e) => e.seq < before), more }
}

/** Returns true when it answered; false = not this path. */
export function timelineRoute(req: IncomingMessage, res: ServerResponse, url: URL, method: string, deps: () => HistoryDeps | null = activeDeps): boolean {
  if (url.pathname !== HISTORY_PATH) return false
  if (method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return true }
  const beforeSeq = intParam(url.searchParams.get('beforeSeq'))
  const limit = intParam(url.searchParams.get('limit'))
  if (beforeSeq === null || limit === null || limit === 0) { json(res, 400, { error: 'invalid_page' }); return true }
  const d = deps()
  if (!d) { json(res, 503, { error: 'ledger_off' }); return true }
  json(res, 200, historyPage(d, beforeSeq, Math.min(limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)))
  return true
}
