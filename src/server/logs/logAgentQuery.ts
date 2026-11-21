// `logs.query` for agents: a read-only, scoped, size-bounded view of the server log. Visible to an agent:
// every channel at warn/error, plus every level for its own node and the nodes wired to it; never a sensitive
// channel (auth, credentials, secrets, tokens, cookies, accounts). Every row is re-scrubbed on the way out.
import { isLogLevel, LOG_LEVELS, type LogEntry, type LogLevel } from '../../shared/logEntry'
import { matchesQuery } from './logBus'
import { sanitizeData, scrubDeep, scrubText } from './logSanitize'

export const AGENT_LOG_MAX_ROWS = 200
export const AGENT_LOG_DEFAULT_ROWS = 50
export const AGENT_LOG_MAX_BYTES = 64 * 1024
const MAX_FILTER_CHARS = 200
const SINCE_RE = /^(\d{1,6})([smhd])$/
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Channels (any dotted segment) an agent never reads through the log, whatever the level. */
const SENSITIVE_CHANNEL = /(^|\.)(auth|credentials?[a-z_-]*|secrets?[a-z_-]*|tokens?|cookies?|accounts?)(\.|$)/i
export const isSensitiveChannel = (channel: string): boolean => SENSITIVE_CHANNEL.test(channel)

export interface AgentLogParams { channel?: string; level?: string; since?: string; node?: string; event?: string; q?: string; limit?: number }

/** Who is asking: `self`/`peers` are node ids whose logs at every level are visible; `all` = a human (every node). */
export interface AgentLogScope { self: string | null; peers: ReadonlySet<string>; all: boolean }

export interface AgentLogRow {
  ts: string; level: LogLevel; channel: string; event: string; message: string
  nodeId?: string; profileId?: string; workspaceId?: string; requestId?: string
  data?: Record<string, unknown>
}
export interface AgentLogResult { entries: AgentLogRow[]; matched: number; truncated: boolean; sinceMs: number | null; level: LogLevel }

/** `10m` -> 600000; null when absent or malformed. */
export function parseSince(raw: string | undefined): number | null {
  const m = SINCE_RE.exec(raw ?? '')
  return m ? Number(m[1]) * UNIT_MS[m[2]] : null
}

const rank = (l: LogLevel): number => LOG_LEVELS.indexOf(l)

/** May this scope see `e`? Sensitive channels never; warn+ always; lower levels only for own/wired nodes. */
export function visibleTo(e: LogEntry, scope: AgentLogScope): boolean {
  if (isSensitiveChannel(e.channel)) return false
  if (rank(e.level) >= rank('warn')) return true
  const id = e.ids?.nodeId
  return scope.all ? true : id !== undefined && (id === scope.self || scope.peers.has(id))
}

const clip = (v: string | undefined): string | undefined => v?.slice(0, MAX_FILTER_CHARS) || undefined

function toRow(e: LogEntry): AgentLogRow {
  const data = e.data ? sanitizeData(scrubDeep(e.data) as Record<string, unknown>) : undefined
  return {
    ts: new Date(e.ts).toISOString(), level: e.level, channel: e.channel, event: e.event, message: scrubText(e.message, 500),
    ...(e.ids?.nodeId ? { nodeId: e.ids.nodeId } : {}), ...(e.ids?.profileId ? { profileId: e.ids.profileId } : {}),
    ...(e.ids?.workspaceId ? { workspaceId: e.ids.workspaceId } : {}), ...(e.ids?.requestId ? { requestId: e.ids.requestId } : {}),
    ...(data ? { data } : {}),
  }
}

/** Newest-first selection of up to `limit` rows, then chronological, trimmed (oldest first) to the byte budget. */
export function agentLogQuery(entries: readonly LogEntry[], params: AgentLogParams, scope: AgentLogScope, now: number): AgentLogResult {
  const level = isLogLevel(params.level) ? params.level : params.node ? 'info' : 'warn'
  const sinceMs = parseSince(params.since)
  const event = clip(params.event)
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? AGENT_LOG_DEFAULT_ROWS)), AGENT_LOG_MAX_ROWS)
  const query = { level, channel: clip(params.channel), q: clip(params.q) }
  const hits = entries.filter((e) =>
    (sinceMs === null || e.ts >= now - sinceMs) && (!params.node || e.ids?.nodeId === params.node)
    && (!event || e.event === event || e.event.startsWith(event)) && matchesQuery(e, query) && visibleTo(e, scope))
  let rows = hits.slice(-limit).map(toRow)
  let truncated = hits.length > rows.length
  while (rows.length > 1 && JSON.stringify(rows).length > AGENT_LOG_MAX_BYTES) { rows = rows.slice(1); truncated = true }
  return { entries: rows, matched: hits.length, truncated, sinceMs, level }
}
