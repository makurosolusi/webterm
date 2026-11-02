// Process-wide log stream: one backfill + one SSE connection + one ring buffer, shared by every
// `useLogStream` caller (status bar and Output panel). Ref-counted: the connection opens with the
// first subscriber and closes, with state reset, when the last one leaves.
//
// Reconnect is manual (like chat/chatStream) so every attempt re-runs the backfill from the last
// seen seq: that closes gaps and also detects a server restart (seq went backwards).
import { LOG_LEVELS, type LogChannelInfo, type LogEntry, type LogLevel, type LogQueryResult } from '../../shared/logEntry'
import { TOKEN_HEADER, tokenQuery } from '../api'
import { peekToken } from '../transportToken'

export type LogConnection = 'connecting' | 'open' | 'closed'

export interface LogStreamState {
  entries: LogEntry[]
  channels: LogChannelInfo[]
  level: LogLevel
  counts: { error: number; warn: number }
  connection: LogConnection
}

/** Client ring size; matches the server's default WEBTERM_LOG_BUFFER. */
export const LOG_CLIENT_CAP = 5000
/** Page size of one backfill request (server maximum). */
const BACKFILL_LIMIT = 2000
/** Backfill pages per connect attempt: enough to drain one full ring. */
const BACKFILL_MAX_PAGES = Math.ceil(LOG_CLIENT_CAP / BACKFILL_LIMIT) + 1
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 10_000
const LOGS_PATH = '/api/logs'

const initial = (): LogStreamState => ({
  entries: [], channels: [], level: 'info', counts: { error: 0, warn: 0 }, connection: 'connecting',
})

let state = initial()
const listeners = new Set<() => void>()
let refs = 0
let generation = 0
let lastSeq = 0
let attempts = 0
let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let channelCounts = new Map<string, number>()

const emit = (patch: Partial<LogStreamState>): void => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Current snapshot (stable object between changes). */
export function getLogStreamState(): LogStreamState {
  return state
}

/** Subscribe a listener; the first subscriber starts the stream, the last one stops it. */
export function subscribeLogStream(listener: () => void): () => void {
  listeners.add(listener)
  refs += 1
  if (refs === 1) start()
  return () => {
    listeners.delete(listener)
    refs -= 1
    if (refs === 0) stop()
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const token = peekToken()
  return { Accept: 'application/json', ...extra, ...(token === '' ? {} : { [TOKEN_HEADER]: token }) }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headers(body === undefined ? undefined : { 'Content-Type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status})`)
  return (res.headers.get('content-length') === '0' || res.status === 204 ? undefined : await res.json()) as T
}

function channelList(): LogChannelInfo[] {
  return [...channelCounts].map(([channel, count]) => ({ channel, count })).sort((a, b) => a.channel.localeCompare(b.channel))
}

/** Append entries newer than the cursor, trim to the cap, and refresh derived counts. */
function ingest(incoming: LogEntry[]): void {
  const fresh = incoming.filter((entry) => entry.seq > lastSeq)
  if (fresh.length === 0) return
  lastSeq = fresh.reduce((max, entry) => Math.max(max, entry.seq), lastSeq)
  let entries = state.entries.concat(fresh)
  const counts = { ...state.counts }
  const bump = (entry: LogEntry, delta: number): void => {
    channelCounts.set(entry.channel, (channelCounts.get(entry.channel) ?? 0) + delta)
    if ((channelCounts.get(entry.channel) ?? 0) <= 0) channelCounts.delete(entry.channel)
    if (entry.level === 'error') counts.error += delta
    else if (entry.level === 'warn') counts.warn += delta
  }
  for (const entry of fresh) bump(entry, 1)
  if (entries.length > LOG_CLIENT_CAP) {
    for (const dropped of entries.slice(0, entries.length - LOG_CLIENT_CAP)) bump(dropped, -1)
    entries = entries.slice(-LOG_CLIENT_CAP)
  }
  emit({ entries, counts, channels: channelList() })
}

function resetBuffer(): void {
  channelCounts = new Map()
  emit({ entries: [], channels: [], counts: { error: 0, warn: 0 } })
}

async function backfill(): Promise<LogLevel> {
  let level = state.level
  for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
    const res = await api<LogQueryResult>('GET', `${LOGS_PATH}?afterSeq=${lastSeq}&limit=${BACKFILL_LIMIT}`)
    if (lastSeq > 0 && res.lastSeq < lastSeq) {
      // Server restarted: its seq counter started over, so the old buffer is meaningless.
      lastSeq = 0
      resetBuffer()
      continue
    }
    level = res.level
    ingest(res.entries)
    if (res.entries.length < BACKFILL_LIMIT) break
  }
  return level
}

function scheduleRetry(gen: number): void {
  if (gen !== generation) return
  closeSource()
  const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS)
  attempts += 1
  emit({ connection: 'closed' })
  retryTimer = setTimeout(() => void connect(gen), delay)
}

function closeSource(): void {
  if (!source) return
  source.onopen = null
  source.onerror = null
  source.close()
  source = null
}

async function connect(gen: number): Promise<void> {
  retryTimer = null
  emit({ connection: 'connecting' })
  try {
    const level = await backfill()
    if (gen !== generation) return
    emit({ level })
    const token = tokenQuery()
    const next = new EventSource(`${LOGS_PATH}/stream?afterSeq=${lastSeq}${token === '' ? '' : `&${token}`}`)
    source = next
    next.onopen = () => {
      if (gen !== generation) return
      attempts = 0
      emit({ connection: 'open' })
    }
    next.addEventListener('log', (event) => {
      if (gen !== generation) return
      try {
        ingest([JSON.parse((event as MessageEvent<string>).data) as LogEntry])
      } catch {
        // A malformed frame must not kill the stream; the next reconnect backfill re-syncs from lastSeq.
      }
    })
    next.onerror = () => scheduleRetry(gen)
  } catch {
    // Backfill or EventSource construction failed: surface 'closed' and retry with backoff.
    scheduleRetry(gen)
  }
}

function start(): void {
  generation += 1
  attempts = 0
  void connect(generation)
}

function stop(): void {
  generation += 1
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
  closeSource()
  lastSeq = 0
  channelCounts = new Map()
  state = initial()
}

/** Empty the server buffer (DELETE /api/logs) and the local one. */
export async function clearLogStream(): Promise<void> {
  await api<unknown>('DELETE', LOGS_PATH)
  resetBuffer()
}

/** Change the server's effective level (PUT /api/logs/level). */
export async function setLogStreamLevel(level: LogLevel): Promise<void> {
  if (!(LOG_LEVELS as readonly string[]).includes(level)) throw new Error(`Unknown log level: ${level}`)
  const res = await api<{ level?: LogLevel } | undefined>('PUT', `${LOGS_PATH}/level`, { level })
  emit({ level: res?.level ?? level })
}
