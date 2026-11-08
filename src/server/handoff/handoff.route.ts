// HTTP for handoff cards. Root token / same-origin UI only (not in `isNodeTokenPath`):
//   GET  /api/handoff                     -> { workspaces: [{ id, name, agents: [{ nodeId, title, card }] }] }
//   POST /api/handoff/continue {workspaceId} -> { results: ContinueResult[] }  ("Continue from yesterday")
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LEDGER_OFF, type RouteResult } from '../apiShared.types'
import { BodyReadError } from '../cappedRequestBody'
import { HANDOFF_MAX_CHARS, filterHandoffContext } from '../verifier/handoff.filter'
import { hasClaudeHookSettings, isSafeSessionId, type Workspace, type WsNode } from '../../shared/workspace'
import { latestCard } from './handoff.store'
import { continueWorkspace, resumableAgents, type ContinueDeps } from './handoff.service'

export const HANDOFF_PATH = '/api/handoff'
export const HANDOFF_CONTINUE_PATH = `${HANDOFF_PATH}/continue`
export const HANDOFF_BODY_MAX_BYTES = 4 * 1024
/** Transcript lines read per card (the tail; masking then caps the chars). */
const TRANSCRIPT_LINES = 400

export interface HandoffRouteDeps {
  deps: ContinueDeps
  workspaces: () => Workspace[]
}

/** Newest lines whose joined length fits `max` (the tail is what the next session needs). */
export function tailWithin(lines: readonly string[], max: number): string[] {
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    used += lines[i]!.length + 1
    if (used > max) break
    out.unshift(lines[i]!)
  }
  return out
}

/** Claude transcript of a node's session (`<sessionId>.jsonl` under any project dir), rendered. */
export async function claudeTranscriptLines(node: WsNode): Promise<string[]> {
  const sid = node.sessionId
  if (!node.agentId || !hasClaudeHookSettings(node.agentId) || !sid || !isSafeSessionId(sid, true)) return []
  const [{ claudeProjectsRoot }, { readTranscriptFile, renderTranscriptLines }] = await Promise.all([import('../transcriptPresence'), import('../contextLinkTranscript')])
  const root = claudeProjectsRoot()
  let dirs: string[]
  try { dirs = readdirSync(root) } catch { return [] } // no claude config dir = no transcript, not an error
  const dir = dirs.find((d) => existsSync(join(root, d, `${sid}.jsonl`)))
  const buf = dir ? readTranscriptFile(join(root, dir, `${sid}.jsonl`)) : null
  return buf ? renderTranscriptLines(buf).slice(-TRANSCRIPT_LINES) : []
}

let narrate: ContinueDeps['narrate'] | undefined

async function productionDeps(): Promise<HandoffRouteDeps | null> {
  const [{ activeLedgerRuntime }, { activeEventLog }, { startOutbox }, { createClaudeStructured }, { db }] = await Promise.all([
    import('../ledger/ledgerRuntimeState'), import('../events/eventsRuntime'), import('../outbox/outboxRuntime'),
    import('../central/context/claudeStructured'), import('../db'),
  ])
  const ledger = activeLedgerRuntime()
  const log = activeEventLog()
  if (!ledger || !log) return null
  const outbox = await startOutbox()
  narrate ??= createClaudeStructured('handoff')
  return {
    workspaces: () => db.list(),
    deps: {
      db: ledger.db, log, now: Date.now, narrate,
      transcript: claudeTranscriptLines,
      mask: (lines) => filterHandoffContext(tailWithin(lines, HANDOFF_MAX_CHARS).join('\n')),
      enqueue: (input) => outbox.enqueue(input),
      refusal: (nodeId) => outbox.refusal(nodeId),
    },
  }
}

type Parsed = { ok: true; body: Record<string, unknown> } | { ok: false; result: RouteResult }

async function readJson(read: () => Promise<string>): Promise<Parsed> {
  let raw: string
  try { raw = await read() } catch (err) {
    if (err instanceof BodyReadError) return { ok: false, result: { status: err.reason === 'too_large' ? 413 : 400, body: { error: err.reason } } }
    throw err
  }
  try {
    const v: unknown = raw === '' ? {} : JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, body: v as Record<string, unknown> }
  } catch { /* falls through to the 400 below: a bad body is the caller's mistake */ }
  return { ok: false, result: { status: 400, body: { error: 'invalid_json' } } }
}

/** null = not a handoff path. */
export async function handoffRoute(path: string, method: string, body: () => Promise<string>, given?: HandoffRouteDeps): Promise<RouteResult | null> {
  if (path !== HANDOFF_PATH && path !== HANDOFF_CONTINUE_PATH) return null
  const want = path === HANDOFF_PATH ? 'GET' : 'POST'
  if (method !== want) return { status: 405, body: { error: 'method_not_allowed' } }
  const route = given ?? (await productionDeps())
  if (!route) return LEDGER_OFF
  const { deps } = route
  const list = route.workspaces()
  if (path === HANDOFF_PATH) {
    const workspaces = list.map((ws) => ({
      id: ws.id, name: ws.name,
      agents: resumableAgents(ws).map((n) => ({ nodeId: n.id, title: n.title?.trim() || n.agentId, card: latestCard(deps.db, n.id) })),
    })).filter((w) => w.agents.length > 0)
    return { status: 200, body: { workspaces } }
  }
  const parsed = await readJson(body)
  if (!parsed.ok) return parsed.result
  const ws = list.find((w) => w.id === parsed.body['workspaceId'])
  if (!ws) return { status: 404, body: { error: 'workspace_not_found' } }
  return { status: 200, body: { results: await continueWorkspace(deps, ws) } }
}
