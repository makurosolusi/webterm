// /api/logs routes. Mounted behind the same /api gate as settings (root token only; per-node tokens
// never reach it, see isNodeTokenPath). Returns false for paths it does not own.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLogLevel, type LogLevel, type LogQueryResult } from '../../shared/logEntry'
import { readCappedRequestBody } from '../cappedRequestBody'
import { logBus } from './logBus'
import { handleClientLogs } from './logClientApi'
import { createLogger, getLogDir, getLogLevel, getRetention, setLogLevel } from './logger'
import { logStats } from './logRetention'
import { handleLogStream } from './logSse'

export const LOGS_PATH = '/api/logs'
const DEFAULT_QUERY_LIMIT = 1000
const MAX_QUERY_LIMIT = 2000
const LEVEL_BODY_MAX_BYTES = 1024
const MAX_FILTER_CHARS = 200

const log = createLogger('logs')

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Non-negative integer from a query value; undefined when absent, null when malformed. */
function intParam(raw: string | null): number | undefined | null {
  if (raw === null || raw === '') return undefined
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null
}

function handleQuery(res: ServerResponse, url: URL): void {
  const afterSeq = intParam(url.searchParams.get('afterSeq'))
  const limit = intParam(url.searchParams.get('limit'))
  const level = url.searchParams.get('level') || undefined
  if (afterSeq === null || limit === null || (level !== undefined && !isLogLevel(level))) return json(res, 400, { error: 'invalid_query' })
  const result: LogQueryResult = {
    entries: logBus.query({
      afterSeq,
      limit: Math.min(limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT),
      level: level as LogLevel | undefined,
      channel: url.searchParams.get('channel')?.slice(0, MAX_FILTER_CHARS) || undefined,
      q: url.searchParams.get('q')?.slice(0, MAX_FILTER_CHARS) || undefined,
    }),
    lastSeq: logBus.lastSeq,
    channels: logBus.channels(),
    level: getLogLevel(),
    capacity: logBus.capacity,
    dropped: logBus.dropped,
  }
  json(res, 200, result)
}

async function handleLevel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const read = await readCappedRequestBody(req, LEVEL_BODY_MAX_BYTES)
  if (!read.ok) return json(res, read.reason === 'too_large' ? 413 : 400, { error: read.reason })
  let level: unknown
  try { level = (JSON.parse(read.body) as { level?: unknown } | null)?.level } catch { return json(res, 400, { error: 'bad_json' }) }
  if (!isLogLevel(level)) return json(res, 400, { error: 'invalid_level' })
  const previous = getLogLevel()
  setLogLevel(level)
  log.info('logs.level', `Log level changed from ${previous} to ${level}`)
  json(res, 200, { level })
}

/** Size/span of the log directory plus the in-memory level counts; `files` is null while file logging is off. */
async function handleStats(res: ServerResponse): Promise<void> {
  const dir = getLogDir()
  const byLevel: Record<string, number> = {}
  for (const e of logBus.snapshot()) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1
  json(res, 200, { files: dir ? await logStats(dir, getRetention()) : null, buffer: { entries: logBus.snapshot().length, capacity: logBus.capacity, dropped: logBus.dropped, byLevel } })
}

export async function logsRoute(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const path = url.pathname
  if (path !== LOGS_PATH && !path.startsWith(`${LOGS_PATH}/`)) return false
  const verbs: Record<string, string> = { [LOGS_PATH]: 'GET DELETE', [`${LOGS_PATH}/stream`]: 'GET', [`${LOGS_PATH}/level`]: 'PUT', [`${LOGS_PATH}/client`]: 'POST', [`${LOGS_PATH}/stats`]: 'GET' }
  const allowed = verbs[path]
  if (allowed === undefined) return false
  if (!allowed.split(' ').includes(method)) { json(res, 405, { error: 'method_not_allowed' }); return true }
  if (path === LOGS_PATH && method === 'GET') handleQuery(res, url)
  else if (path === LOGS_PATH) {
    logBus.clear()
    log.info('logs.clear', 'Log buffer cleared')
    res.statusCode = 204
    res.end()
  } else if (path.endsWith('/stream')) handleLogStream(req, res, url)
  else if (path.endsWith('/stats')) await handleStats(res)
  else if (path.endsWith('/level')) await handleLevel(req, res)
  else await handleClientLogs(req, res)
  return true
}
