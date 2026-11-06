// HTTP surface of the agent chat node (PLAN/AGENT-CHAT.md D6, D7): `/api/agent-chat/:nodeId/<verb>`.
// Root-only through the shared `/api/*` gate in index.ts (node tokens never reach it: not in
// `isNodeTokenPath`). SSE replays the session log after `?after=` / Last-Event-ID, then goes live,
// framed and heartbeated like centralChatSse.
import type { RouteCtx } from '../routes/route.core'
import { json } from '../routes/route.core'
import { BodyReadError } from '../cappedRequestBody'
import { DEFAULT_HEARTBEAT_MS, formatSseFrame } from '../central/chat/streamHub'
import { firstHeader } from '../httpHeaders'
import { createLogger } from '../logs'
import type { AgentChatEvent, AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import { isPermissionMode, isSafeNodeId } from '../../shared/workspace'
import type { AgentChatPool } from './agentChat.pool'
import type { AgentChatSession } from './agentChat.session'
import { historyPage, loadTranscript, toolResultText, type LoadTranscript } from './agentChat.history'

const log = createLogger('agent-chat')

/** Chars of one user message. */
export const AGENT_CHAT_TEXT_MAX = 100_000
/** Bytes of one POST body (a permission answer can carry an edited tool input). */
export const AGENT_CHAT_BODY_MAX_BYTES = 1024 * 1024
/** SSE `event:` name of every agent chat frame. */
export const AGENT_CHAT_SSE_EVENT = 'agent-chat'

const PATH = /^\/api\/agent-chat\/([^/]+)\/([a-z]+)$/
const VERB_METHOD: Record<string, 'GET' | 'POST'> = { stream: 'GET', history: 'GET', send: 'POST', interrupt: 'POST', permission: 'POST', mode: 'POST' }
const PRIORITIES = new Set(['now', 'next'])
const UINT = /^\d+$/

export interface AgentChatRouteDeps {
  pool: AgentChatPool
  load?: LoadTranscript
  heartbeatMs?: number
}

type Ctx = Pick<RouteCtx, 'req' | 'res' | 'url' | 'path' | 'method' | 'body'>
type Fail = { status: number; error: string; reason: string }
type Body = Record<string, unknown>

const fail = (c: Ctx, f: Fail): true => { json(c.res, f.status, { error: f.error, reason: f.reason }); return true }
const ok = (c: Ctx): true => { json(c.res, 200, { ok: true }); return true }
const bad = (reason: string): Fail => ({ status: 400, error: 'bad_request', reason })

/** Non-negative integer query value; undefined = absent, null = invalid. */
function uint(raw: string | null | undefined): number | undefined | null {
  if (raw === null || raw === undefined) return undefined
  return UINT.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
}

function decodeNodeId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    if (err instanceof URIError) return undefined // malformed escape = not a node id
    throw err
  }
}

/** JSON object body under the cap; anything else is a Fail. */
async function readObject(c: Ctx): Promise<{ body: Body } | { fail: Fail }> {
  let raw: string
  try {
    raw = await c.body(AGENT_CHAT_BODY_MAX_BYTES)()
  } catch (err) {
    if (!(err instanceof BodyReadError)) throw err
    return { fail: err.reason === 'too_large'
      ? { status: 413, error: 'too_large', reason: `Request body is over ${AGENT_CHAT_BODY_MAX_BYTES} bytes.` }
      : bad('Request body could not be read.') }
  }
  let v: unknown
  try {
    v = JSON.parse(raw || '{}')
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    return { fail: bad('Request body is not valid JSON.') }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? { body: v as Body } : { fail: bad('Request body must be a JSON object.') }
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

function stream(c: Ctx, deps: AgentChatRouteDeps, nodeId: string, s: AgentChatSession): true {
  const after = uint(firstHeader(c.req.headers['last-event-id']) ?? c.url.searchParams.get('after'))
  if (after === null) return fail(c, bad('after / Last-Event-ID must be a non-negative integer.'))
  const from = after ?? 0
  const res = c.res
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  const write = (e: AgentChatEvent): void => {
    if (!res.writableEnded) res.write(formatSseFrame({ kind: 'event', id: e.seq, event: AGENT_CHAT_SSE_EVENT, data: e }))
  }
  const replay = s.events(from)
  const oldest = replay[0]?.seq ?? Number.POSITIVE_INFINITY
  // The init the log cap dropped (the client needs its session id), then prompts still waiting for an
  // answer that the client's cursor already passed, then the regular replay.
  const init = deps.pool.lastInit(nodeId)
  if (init && init.seq > from && init.seq < oldest) write(init)
  const open = new Set(deps.pool.gate.pending(nodeId).map((r) => r.requestId))
  for (const e of s.events(0)) if (e.t === 'permission' && e.seq <= from && open.has(e.requestId)) write(e)
  for (const e of replay) write(e)
  const off = s.subscribe(write)
  const beat = setInterval(() => { if (!res.writableEnded) res.write(formatSseFrame({ kind: 'heartbeat' })) }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
  beat.unref?.() // never hold the process open for a heartbeat
  // Both res and req emit close on a disconnect; unsubscribe exactly once.
  let done = false
  const cleanup = (): void => { if (done) return; done = true; off(); clearInterval(beat) }
  res.once('close', cleanup)
  c.req.once('close', cleanup)
  return true
}

async function history(c: Ctx, deps: AgentChatRouteDeps, nodeId: string, s: AgentChatSession): Promise<true> {
  const tool = c.url.searchParams.get('tool')
  const before = uint(c.url.searchParams.get('before'))
  const limit = uint(c.url.searchParams.get('limit'))
  if (before === null || limit === null) return fail(c, bad('before and limit must be non-negative integers.'))
  const sessionId = deps.pool.sessionId(nodeId)
  if (!sessionId) {
    if (tool) return fail(c, { status: 404, error: 'not_found', reason: 'This chat has no transcript yet.' })
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
  const read = await readObject(c)
  if ('fail' in read) return fail(c, read.fail)
  const b = read.body
  if (verb === 'send') {
    if (typeof b.text !== 'string' || !b.text.trim()) return fail(c, bad('text must be a non-empty string.'))
    if (b.text.length > AGENT_CHAT_TEXT_MAX) return fail(c, bad(`text is over ${AGENT_CHAT_TEXT_MAX} characters.`))
    if (b.priority !== undefined && !PRIORITIES.has(b.priority as string)) return fail(c, bad('priority must be "now" or "next".'))
    const r = deps.pool.send(nodeId, b.text, b.priority as 'now' | 'next' | undefined)
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
  if (verb === 'stream') return stream(c, deps, nodeId, s)
  if (verb === 'history') return history(c, deps, nodeId, s)
  return post(c, deps, nodeId, verb, s)
}
