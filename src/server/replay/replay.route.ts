// HTTP for correlated session replay. Root token / same-origin UI only (not in `isNodeTokenPath`):
// it reads transcripts and diffs of every agent in a workspace.
//   GET /api/replay?workspace=<id>[&node=<id>&from=<ms>&to=<ms>&cursor=<c>&limit=<n>]
//       -> { items (ascending), nextCursor }   one page of the merged lanes
//   GET /api/replay/state?workspace=<id>&t=<ms>[&node=<id>]
//       -> { t, transcript, checkpoint, costMicros, scrollback }   the scrub state at t
// "Rewind to here" is POST /api/checkpoints/rewind (checkpoint/checkpoint.route.ts), not a route here.
import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteResult } from '../apiShared.types'
import { spentMicros } from '../cost/costStore'
import { isSafeSessionId, type Workspace } from '../../shared/workspace'
import { checkpointAt as gitCheckpointAt, type CheckpointAt } from './replay.checkpoint'
import { decodeCursor, mergePage } from './replay.model'
import { costItems, eventItems, parseTranscript, transcriptItems, type ReplayRange, type ReplayScope, type TranscriptEntry } from './replay.sources'

export const REPLAY_PATH = '/api/replay'
export const REPLAY_DEFAULT_LIMIT = 200
export const REPLAY_MAX_LIMIT = 500
/** Transcript lines returned in a scrub state (the tail up to t). */
export const STATE_TRANSCRIPT_LINES = 200
/** Scrollback tail returned in a scrub state (characters). */
export const STATE_SCROLLBACK_CHARS = 16 * 1024

export interface ReplayDeps {
  db: Database
  workspace(id: string): Pick<Workspace, 'id' | 'cwd' | 'nodes'> | null
  /** Raw Claude JSONL of a node's session (bounded tail), or null when it has none. */
  transcript(nodeId: string): string | null
  /** Live PTY scrollback (ANSI stripped) of a node, or null when no session is running. */
  scrollback(nodeId: string): string | null
  checkpointAt?(workspaceId: string, cwd: string | undefined, t: number): Promise<CheckpointAt | null>
}

const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })
const intParam = (raw: string | null): number | undefined | null =>
  raw === null || raw === '' ? undefined : /^\d{1,15}$/.test(raw) ? Number(raw) : null

function scopeOf(deps: ReplayDeps, q: URLSearchParams): ReplayScope | RouteResult {
  const ws = deps.workspace(q.get('workspace') ?? '')
  if (!ws) return fail(404, 'workspace_not_found')
  const nodeIds = (ws.nodes ?? []).map((n) => n.id)
  const nodeId = q.get('node') || null
  if (nodeId && !nodeIds.includes(nodeId)) return fail(404, 'node_not_found')
  return { workspaceId: ws.id, nodeId, nodeIds }
}

function transcripts(deps: ReplayDeps, s: ReplayScope): { nodeId: string; entries: TranscriptEntry[] }[] {
  return (s.nodeId ? [s.nodeId] : s.nodeIds).flatMap((nodeId) => {
    const raw = deps.transcript(nodeId)
    return raw ? [{ nodeId, entries: parseTranscript(nodeId, raw) }] : []
  })
}

/** One page of the merged timeline. */
export function replayPage(deps: ReplayDeps, s: ReplayScope, r: ReplayRange, cursor: ReturnType<typeof decodeCursor>, limit: number) {
  const c = cursor === 'invalid' ? null : cursor
  return mergePage([
    eventItems(deps.db, s, r, c, limit),
    transcriptItems(transcripts(deps, s), r, c, limit),
    costItems(deps.db, s, r, c, limit),
  ], limit)
}

/** Scrub state at t: transcript tail, checkpoint diff, accumulated cost, and live scrollback when t is now. */
export async function replayState(deps: ReplayDeps, s: ReplayScope, t: number, from: number, now: number = Date.now()) {
  const lines = transcripts(deps, s)
    .flatMap(({ entries }) => entries.filter((e) => e.ts <= t && e.ts >= from))
    .sort((a, b) => a.ts - b.ts)
    .flatMap((e) => e.lines.map((text) => ({ ts: e.ts, nodeId: e.nodeId, text })))
    .slice(-STATE_TRANSCRIPT_LINES)
  const ws = deps.workspace(s.workspaceId)
  const checkpoint = await (deps.checkpointAt ?? gitCheckpointAt)(s.workspaceId, ws?.cwd, t)
  const { costMicros } = spentMicros(deps.db, { since: from, until: t + 1, ...(s.nodeId ? { nodeId: s.nodeId } : { workspaceId: s.workspaceId }) })
  // PTY output is kept in memory without timestamps, so only "now" has a terminal snapshot.
  const live = s.nodeId && t >= now ? deps.scrollback(s.nodeId) : null
  return { t, transcript: lines, checkpoint, costMicros, scrollback: live === null ? null : { asOf: now, text: live.slice(-STATE_SCROLLBACK_CHARS) } }
}

/** null = not a replay path. */
export async function replayRoute(path: string, method: string, q: URLSearchParams, deps: () => Promise<ReplayDeps | null>): Promise<RouteResult | null> {
  if (path !== REPLAY_PATH && path !== `${REPLAY_PATH}/state`) return path.startsWith(`${REPLAY_PATH}/`) ? fail(404, 'unknown route') : null
  if (method !== 'GET') return fail(405, 'method_not_allowed')
  const from = intParam(q.get('from'))
  const to = intParam(q.get('to'))
  const limit = intParam(q.get('limit'))
  const t = intParam(q.get('t'))
  const cursor = decodeCursor(q.get('cursor'))
  if (from === null || to === null || limit === null || limit === 0 || t === null || cursor === 'invalid') return fail(400, 'invalid_query')
  const range = { from: from ?? 0, to: to ?? Number.MAX_SAFE_INTEGER }
  if (range.from >= range.to) return fail(400, 'invalid_range')
  const d = await deps()
  if (!d) return fail(503, 'ledger_off')
  const scope = scopeOf(d, q)
  if ('status' in scope) return scope
  if (path === REPLAY_PATH) return { status: 200, body: replayPage(d, scope, range, cursor, Math.min(limit ?? REPLAY_DEFAULT_LIMIT, REPLAY_MAX_LIMIT)) }
  if (t === undefined) return fail(400, 'invalid_query')
  return { status: 200, body: await replayState(d, scope, t, range.from) }
}

/** Production deps over the process runtime; loaded lazily (bun:sqlite, PTY registry). */
export async function processReplayDeps(): Promise<ReplayDeps | null> {
  const [{ activeLedgerRuntime }, { db }, { sessions }, { readTranscriptFile }, { stripAnsi }, { claudeProjectsRoot }] = await Promise.all([
    import('../ledger/ledgerRuntimeState'), import('../db'), import('../sessions'), import('../contextLinkTranscript'), import('../contextLinkRender'),
    import('../transcriptPresence'),
  ])
  const ledger = activeLedgerRuntime()
  if (!ledger) return null
  // Hook-reported path first (live session); after a restart, `<sessionId>.jsonl` under any claude
  // project dir, the same lookup as handoff's `claudeTranscriptLines`.
  const bySession = (nodeId: string): string | null => {
    const node = db.list().flatMap((w) => w.nodes ?? []).find((n) => n.id === nodeId)
    const sid = node?.sessionId
    if (!sid || !isSafeSessionId(sid, true)) return null
    const root = claudeProjectsRoot()
    let dirs: string[]
    try { dirs = readdirSync(root) } catch { return null } // no claude config dir = no transcript
    const dir = dirs.find((d) => existsSync(join(root, d, `${sid}.jsonl`)))
    return dir ? join(root, dir, `${sid}.jsonl`) : null
  }
  return {
    db: ledger.db,
    workspace: (id) => db.get(id),
    transcript: (nodeId) => { const p = sessions.getTranscript(nodeId) ?? bySession(nodeId); return p ? readTranscriptFile(p) : null },
    scrollback: (nodeId) => (sessions.isLive(nodeId) ? stripAnsi(sessions.getTerminal(nodeId)) : null),
  }
}
