// HTTP surface of the agent chat node (PLAN/AGENT-CHAT.md D6, D7): `/api/agent-chat/:nodeId/<verb>`.
// UI-only: its entry is wrapped in `uiOnly` (routes/agentChat.routes.ts); node tokens never reach
// it (not in `isNodeTokenPath`). Verbs live in agentChat.route.{stream,attach,controls}.ts; this file
// dispatches (rewind / fork: agentChat.route.branch.ts) and keeps send / permission / mode / interrupt / history.
import { json } from '../routes/route.core'
import { createLogger } from '../logs'
import { AGENT_CHAT_TEXT_MAX, type AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import { isPermissionMode, isSafeNodeId } from '../../shared/workspace'
import type { AgentChatPool } from './agentChat.pool'
import type { AgentChatSession } from './agentChat.session'
import { historyPage, loadTranscript, toolResultText, type LoadTranscript } from './agentChat.history'
import { AGENT_CHAT_SEND_BODY_MAX_BYTES, imageVerb, parseSend, uploadVerb } from './agentChat.route.attach'
import { CONTROL_VERBS, controlVerb, type ListSessions } from './agentChat.route.controls'
import { BRANCH_VERBS, branchVerb, type ForkSession } from './agentChat.route.branch'
import { AGENT_CHAT_BODY_MAX_BYTES, bad, fail, ok, readObject, uint, type Body, type Ctx, type Fail } from './agentChat.route.core'
import { AGENT_CHAT_SSE_EVENT, streamVerb } from './agentChat.route.stream'

const log = createLogger('agent-chat')

export { AGENT_CHAT_BODY_MAX_BYTES, AGENT_CHAT_SSE_EVENT, AGENT_CHAT_TEXT_MAX } // TEXT_MAX: shared with the client composer

const PATH = /^\/api\/agent-chat\/([^/]+)\/([a-z]+)$/
const VERB_METHOD: Record<string, 'GET' | 'POST'> = {
  stream: 'GET', history: 'GET', send: 'POST', upload: 'POST', interrupt: 'POST', permission: 'POST', mode: 'POST', ...CONTROL_VERBS, ...BRANCH_VERBS,
}

export interface AgentChatRouteDeps {
  pool: AgentChatPool
  load?: LoadTranscript
  heartbeatMs?: number
  /** Root of staged uploads (default `<data dir>/agent-chat-uploads`); tests pass a temp dir. */
  uploadsDir?: string
  /** SDK `listSessions` (GET sessions); tests inject a fake. */
  listSessions?: ListSessions
  /** SDK `forkSession` (POST fork); tests inject a fake. */
  forkSession?: ForkSession
}

function decodeNodeId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    if (err instanceof URIError) return undefined // malformed escape = not a node id
    throw err
  }
}

function parseAnswer(b: Body): { answer: AgentChatPermissionAnswer } | Fail {
  if (typeof b.requestId !== 'string' || !b.requestId) return bad('requestId must be a non-empty string.')
  if (b.behavior === 'deny') {
    if (typeof b.message !== 'string') return bad('A deny answer needs a message string.')
    return { answer: { requestId: b.requestId, behavior: 'deny', message: b.message } }
  }
  if (b.behavior !== 'allow') return bad('behavior must be "allow" or "deny".')
  const input = b.updatedInput
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return bad('updatedInput must be an object.')
  if (b.always !== undefined && typeof b.always !== 'boolean') return bad('always must be a boolean.')
  return { answer: { requestId: b.requestId, behavior: 'allow', ...(input ? { updatedInput: input as Record<string, unknown> } : {}), ...(b.always ? { always: true } : {}) } }
}

async function history(c: Ctx, deps: AgentChatRouteDeps, nodeId: string, s: AgentChatSession): Promise<true> {
  const tool = c.url.searchParams.get('tool')
  const before = uint(c.url.searchParams.get('before'))
  const limit = uint(c.url.searchParams.get('limit'))
  if (before === null || limit === null) return fail(c, bad('before and limit must be non-negative integers.'))
  const sessionId = deps.pool.sessionId(nodeId)
  if (!sessionId) {
    if (tool || c.url.searchParams.get('image')) return fail(c, { status: 404, error: 'not_found', reason: 'This chat has no transcript yet.' })
    json(c.res, 200, { items: [], next: null })
    return true
  }
  let msgs
  try {
    msgs = await (deps.load ?? loadTranscript)(sessionId)
  } catch (err) {
    log.error('agent_chat.history_failed', 'agent chat transcript read failed', { ids: { nodeId }, operation: 'history', error: err instanceof Error ? err.name : typeof err })
    return fail(c, { status: 502, error: 'transcript_unreadable', reason: 'The Claude transcript of this chat could not be read.' })
  }
  const image = c.url.searchParams.get('image')
  if (image) return imageVerb(c, msgs, image)
  if (tool) {
    const text = toolResultText(msgs, tool)
    if (text === undefined) return fail(c, { status: 404, error: 'not_found', reason: `No result for tool ${tool} in this transcript.` })
    json(c.res, 200, { id: tool, result: text })
    return true
  }
  json(c.res, 200, historyPage(msgs, { before, limit, busy: s.busy() }))
  return true
}

async function post(c: Ctx, deps: AgentChatRouteDeps, nodeId: string, verb: string, s: AgentChatSession): Promise<true> {
  if (verb === 'interrupt') {
    await s.interrupt()
    return ok(c)
  }
  if (verb === 'upload') return uploadVerb(c, nodeId, deps.uploadsDir)
  const read = await readObject(c, verb === 'send' ? AGENT_CHAT_SEND_BODY_MAX_BYTES : AGENT_CHAT_BODY_MAX_BYTES)
  if ('fail' in read) return fail(c, read.fail)
  const b = read.body
  if (verb === 'send') {
    const m = parseSend(b)
    if ('reason' in m) return fail(c, bad(m.reason))
    const r = deps.pool.send(nodeId, m.text, m.priority, m.images)
    if (r && !r.ok) return fail(c, { status: r.status, error: 'session_locked', reason: r.reason })
    return ok(c)
  }
  if (verb === 'permission') {
    const a = parseAnswer(b)
    if (!('answer' in a)) return fail(c, a)
    const r = deps.pool.gate.answer(nodeId, a.answer)
    return r.ok ? ok(c) : fail(c, { status: r.status, error: 'not_pending', reason: r.reason })
  }
  if (!isPermissionMode(b.mode)) return fail(c, bad('mode must be one of manual, auto, acceptEdits, plan, bypassPermissions.'))
  await s.setMode(b.mode)
  return ok(c)
}

/** Route entry: true once it answered (every `/api/agent-chat/*` path is answered here). */
export async function agentChatRoute(c: Ctx, deps: AgentChatRouteDeps): Promise<boolean> {
  const m = c.path.match(PATH)
  if (!m) {
    if (!c.path.startsWith('/api/agent-chat/')) return false
    return fail(c, { status: 404, error: 'not_found', reason: 'Unknown agent chat route.' })
  }
  const nodeId = decodeNodeId(m[1] as string)
  const verb = m[2] as string
  const want = VERB_METHOD[verb]
  if (!want) return fail(c, { status: 404, error: 'not_found', reason: 'Unknown agent chat route.' })
  const s = nodeId && isSafeNodeId(nodeId) ? deps.pool.session(nodeId) : undefined
  if (!nodeId || !s) return fail(c, { status: 404, error: 'not_found', reason: 'No agent chat node with this id.' })
  if (c.method !== want) return fail(c, { status: 405, error: 'method_not_allowed', reason: `${verb} takes ${want}.` })
  if (verb === 'stream') return streamVerb(c, deps, nodeId, s)
  if (verb in CONTROL_VERBS) return controlVerb(c, deps, nodeId, verb, s)
  if (verb in BRANCH_VERBS) return branchVerb(c, deps, nodeId, verb, s)
  if (verb === 'history') return history(c, deps, nodeId, s)
  return post(c, deps, nodeId, verb, s)
}
