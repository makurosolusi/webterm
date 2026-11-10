// Claude node view switch (`POST /api/claude-view/:nodeId {to}`): the same node flips between the Agent
// Chat view (kind 'agentChat', SDK session in `chatSessionId`) and the raw terminal view (kind 'agent',
// claude CLI PTY, session in `sessionId`), carrying the Claude session id so either side resumes it.
// One writer per transcript: the running side is ended before the board flips. Deps are injected so the
// tests boot neither the PTY supervisor nor a real DB; routes/agentChat.routes.ts wires the real ones.
import type { Database } from 'bun:sqlite'
import { AGENT_CHAT_KIND } from '../../shared/agentChat.shape'
import { sessionIdsOf } from '../../shared/paneSessions'
import { SAFE_SESSION_ID, isSafeNodeId } from '../../shared/workspace.ids'
import type { CanvasNode, CanvasPush, NodePatch } from '../canvas/canvasPush'
import { AGENT_TERMINAL_STATES } from '../central/contracts/agent.types'
import { allRows } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { json } from '../routes/route.core'
import { readObject, type Ctx } from './agentChat.route.core'

const log = createLogger('claude-view')

export type ClaudeView = 'chat' | 'terminal'
export const CLAUDE_VIEW_PATH = '/api/claude-view/'
const PATH = /^\/api\/claude-view\/([^/]+)$/
const BODY_MAX_BYTES = 1024
/** Mid-turn or held on a permission prompt; 'waiting' is the idle state after Stop (hookStatus.ts), as outboxDelivery treats it. */
const BUSY_STATUSES = new Set(['working', 'blocked'])

export const CLAUDE_VIEW_HINTS = {
  not_claude: 'Only Claude nodes can switch between the chat and terminal views.',
  split_terminal: 'Close the extra panes first.',
  central_worker: 'This terminal is a worker Central spawned; it stays a terminal.',
  busy: 'Claude is working. Switch when it finishes, or stop it first.',
} as const

export interface ClaudeViewDeps {
  canvas: Pick<CanvasPush, 'workspaceOfNode' | 'update'>
  /** The agent chat pool (production: agentChatPool()). */
  pool: {
    peek(nodeId: string): { busy(): boolean } | undefined
    sessionId(nodeId: string): string | undefined
    close(nodeId: string, reason?: string): void
    gate: { pending(nodeId: string): readonly unknown[] }
  }
  /** Ends a node's PTY sessions as a human close does (sessions.closeNodes). */
  closeNodes(nodes: readonly CanvasNode[]): void
  /** Last agent hook status of one PTY session id. */
  statusOf(sessionId: string): string | undefined
  /** true only when `<sessionId>.jsonl` is proven on disk (probeTranscript === 'present'). */
  hasTranscript(sessionId: string): boolean
  /** A live Central-managed agent PTY shows this node. */
  isCentralWorker(nodeId: string): boolean
  /** Shell launch line of the claude CLI for the node's recorded launch profile. */
  launchLine(profileId: string | undefined): string
}

export type ClaudeViewResult =
  | { status: 200; body: { ok: true; node: CanvasNode } }
  | { status: 400 | 404 | 409 | 500; body: { ok: false; code: string; hint?: string } }

const refuse = (status: 400 | 404 | 409 | 500, code: string, hint?: string): ClaudeViewResult =>
  ({ status, body: { ok: false, code, ...(hint ? { hint } : {}) } })
/** A session id safe to land in `--resume <id>`, else null (never passed on). */
const safeSid = (id: string | undefined): string | null => (id && SAFE_SESSION_ID.test(id) ? id : null)
const isClaudeTerminal = (n: CanvasNode): boolean => n.kind === 'agent' && n.agentId === 'claude'

/** Flip node `nodeId` to view `to`; already there = 200 with nothing changed. */
export function switchClaudeView(deps: ClaudeViewDeps, nodeId: string, to: ClaudeView): ClaudeViewResult {
  const ws = isSafeNodeId(nodeId) ? deps.canvas.workspaceOfNode(nodeId) : null
  const node = ws?.nodes.find((n) => n.id === nodeId)
  if (!ws || !node) return refuse(404, 'node_not_found')
  if (to === 'chat' ? node.kind === AGENT_CHAT_KIND : isClaudeTerminal(node)) return { status: 200, body: { ok: true, node } }
  if (!(to === 'chat' ? isClaudeTerminal(node) : node.kind === AGENT_CHAT_KIND)) return refuse(400, 'not_claude', CLAUDE_VIEW_HINTS.not_claude)

  let patch: NodePatch
  if (to === 'terminal') {
    if (deps.pool.peek(nodeId)?.busy() || deps.pool.gate.pending(nodeId).length > 0) return refuse(409, 'busy', CLAUDE_VIEW_HINTS.busy)
    // Memory first: the stored node may lag what the live session holds (pool.sessionId).
    const sid = safeSid(deps.pool.peek(nodeId) ? deps.pool.sessionId(nodeId) : node.chatSessionId)
    const stopped = stop(nodeId, 'close_chat', () => deps.pool.close(nodeId, 'switched to terminal'))
    if (stopped) return stopped
    patch = { id: nodeId, kind: 'agent', agentId: 'claude', sessionId: sid, chatSessionId: null, cmd: deps.launchLine(node.claudeProfileId) }
  } else {
    const ptys = sessionIdsOf(node.panes, node.id)
    if (ptys.length > 1) return refuse(400, 'split_terminal', CLAUDE_VIEW_HINTS.split_terminal)
    if (deps.isCentralWorker(nodeId)) return refuse(400, 'central_worker', CLAUDE_VIEW_HINTS.central_worker)
    if (BUSY_STATUSES.has(deps.statusOf(ptys[0] as string) ?? '')) return refuse(409, 'busy', CLAUDE_VIEW_HINTS.busy)
    // A minted-but-never-used id has no transcript; the SDK would fail "No conversation found" on it.
    const sid = safeSid(node.sessionId)
    const carried = sid && deps.hasTranscript(sid) ? sid : null
    const stopped = stop(nodeId, 'close_terminal', () => deps.closeNodes([node]))
    if (stopped) return stopped
    patch = { id: nodeId, kind: AGENT_CHAT_KIND, chatSessionId: carried, sessionId: null }
  }

  try {
    const r = deps.canvas.update({ workspaceId: ws.id, patches: [patch] })
    const updated = r.ok ? r.nodes.find((n) => n.id === nodeId) : undefined
    if (updated) return { status: 200, body: { ok: true, node: updated } }
    log.error('claude_view.update_refused', 'switching the Claude view stopped the process but the board was not updated', { ids: { nodeId }, operation: `to_${to}`, code: r.ok ? 'node_missing' : r.code })
  } catch (err) {
    log.error('claude_view.update_failed', 'switching the Claude view stopped the process but the board update threw', { ids: { nodeId }, operation: `to_${to}`, cause: err instanceof Error ? err.message : String(err) })
  }
  return refuse(500, 'switch_failed')
}

/** Run the stop step; a throw is logged and answered (the board stays as it was). */
function stop(nodeId: string, operation: string, fn: () => void): ClaudeViewResult | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    log.error('claude_view.stop_failed', 'ending the running Claude side failed; the view was not switched', { ids: { nodeId }, operation, cause: err instanceof Error ? err.message : String(err) })
    return refuse(500, 'switch_failed')
  }
}

/** Live Central-managed agent PTY showing `nodeId` (by node_id or `c-<agentId>`): the project-less form of canvas.act's `liveAgentNodes`. */
export function isCentralWorkerNode(db: Database, nodeId: string): boolean {
  const ended = AGENT_TERMINAL_STATES.map(() => '?').join(',')
  return allRows(db,
    `SELECT 1 FROM central_agents WHERE runner = 'pty' AND state NOT IN (${ended}) AND (node_id = ? OR ('c-' || id) = ?) LIMIT 1`,
    ...AGENT_TERMINAL_STATES, nodeId, nodeId).length > 0
}

function decode(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    if (err instanceof URIError) return undefined // malformed escape = not a node id
    throw err
  }
}

/** Route entry for `/api/claude-view/*`; `deps` is resolved only once the body is valid (it boots the PTY layer). */
export async function claudeViewRoute(c: Ctx, deps: () => Promise<ClaudeViewDeps>): Promise<true> {
  const m = c.path.match(PATH)
  const nodeId = m ? decode(m[1] as string) : undefined
  const reply = (r: ClaudeViewResult): true => { json(c.res, r.status, r.body); return true }
  if (!nodeId) return reply(refuse(404, 'node_not_found'))
  if (c.method !== 'POST') { json(c.res, 405, { ok: false, code: 'method_not_allowed' }); return true }
  const read = await readObject(c, BODY_MAX_BYTES)
  const b = 'body' in read ? read.body : undefined
  if (!b || Object.keys(b).length !== 1 || (b.to !== 'chat' && b.to !== 'terminal')) return reply(refuse(400, 'bad_request'))
  return reply(switchClaudeView(await deps(), nodeId, b.to))
}
