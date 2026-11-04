// HTTP surface of the Senses log, root token / same-origin UI only: neither path is in
// `isNodeTokenPath` (auth.ts), so a per-node token is refused by the gate in index.ts.
//   GET /api/events/stream[?kind=<pattern>&afterSeq=<n>]  SSE, `id:` = seq, event `sense`
//   GET /api/events/head[?verify=1]                        head hash + anchor status (+ full verify)
// SSE shape copied from logs/logSse.ts (replay + subscribe in one synchronous turn, heartbeat,
// cut a reader that falls MAX_PENDING_BYTES behind; it resumes with Last-Event-ID).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { firstHeader } from '../httpHeaders'
import { anchorStatus, readAnchor } from './eventAnchor'
import { eventBus, isKindPattern, kindMatches } from './eventBus'
import type { SenseEvent } from './eventModel'
import { activeEventsRuntime, type EventsRuntime } from './eventsRuntime'

export const EVENTS_PATH = '/api/events'
export const HEARTBEAT_MS = 15_000
const RETRY_MS = 3000
export const MAX_PENDING_BYTES = 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const frame = (e: SenseEvent): string => `id: ${e.seq}\nevent: sense\ndata: ${JSON.stringify(e)}\n\n`

/** Cursor from Last-Event-ID (wins) or ?afterSeq; undefined = live only, null = malformed. */
function readCursor(req: IncomingMessage, url: URL): number | undefined | null {
  const raw = firstHeader(req.headers['last-event-id']) ?? url.searchParams.get('afterSeq') ?? undefined
  if (raw === undefined || raw === '') return undefined
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null
}

export function handleEventStream(req: IncomingMessage, res: ServerResponse, url: URL, rt: EventsRuntime, heartbeatMs = HEARTBEAT_MS): void {
  const cursor = readCursor(req, url)
  const pattern = url.searchParams.get('kind') ?? '*'
  if (cursor === null || !isKindPattern(pattern)) return json(res, 400, { error: cursor === null ? 'invalid_cursor' : 'invalid_kind' })
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()
  res.write(`retry: ${RETRY_MS}\n\n`)

  let closed = false
  let unsubscribe = (): void => {}
  const heartbeat = setInterval(() => { if (!closed) res.write(': hb\n\n') }, heartbeatMs)
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  const send = (e: SenseEvent): void => {
    if (closed || res.writableEnded) return
    res.write(frame(e))
    if (res.writableLength > MAX_PENDING_BYTES) { cleanup(); res.end() }
  }
  res.on('close', cleanup)
  req.on('close', cleanup)

  // Replay in pages, then subscribe, all synchronously: append is synchronous too, so nothing lands in between.
  // ponytail: a huge backlog replays in one turn; page across turns if replay ever blocks the loop noticeably.
  if (cursor !== undefined) {
    let after = cursor
    for (let page = rt.log.list(after); page.length > 0 && !closed; page = rt.log.list(after)) {
      for (const e of page) if (kindMatches(pattern, e.kind)) send(e)
      after = page[page.length - 1]!.seq
    }
  }
  if (!closed) unsubscribe = eventBus.subscribe(pattern, send)
}

function headBody(rt: EventsRuntime, verify: boolean): unknown {
  let anchor = null
  let status: string
  let anchorError: string | undefined
  try {
    anchor = readAnchor(rt.anchorFile)
    status = anchorStatus(anchor, (seq) => rt.log.hashAt(seq))
  } catch (err) {
    // A malformed anchor is reported, not hidden: it is itself a divergence signal.
    status = 'unreadable'
    anchorError = err instanceof Error ? err.message : String(err)
  }
  return {
    head: rt.log.head(),
    anchor,
    anchorStatus: status,
    anchorError,
    startStatus: rt.startStatus,
    divergedAnchorFile: rt.divergedAnchorFile,
    ...(verify ? { verify: rt.log.verifyChain() } : {}),
  }
}

/** Returns true when it answered; false = not this family. */
export function eventsRoute(req: IncomingMessage, res: ServerResponse, url: URL, method: string, runtime: () => EventsRuntime | null = activeEventsRuntime): boolean {
  const path = url.pathname
  if (path !== `${EVENTS_PATH}/stream` && path !== `${EVENTS_PATH}/head`) return false
  if (method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return true }
  const rt = runtime()
  if (!rt) { json(res, 503, { error: 'ledger_off' }); return true }
  if (path.endsWith('/stream')) handleEventStream(req, res, url, rt)
  else json(res, 200, headBody(rt, url.searchParams.get('verify') === '1'))
  return true
}
