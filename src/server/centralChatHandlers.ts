// Central chat request handlers (RND/08 §7, RND/13 §4 C1). Owns the service cache,
// JSON/error envelopes, body intake (64 KiB), and the non-SSE handlers. The route
// matcher/flag gate stays in `centralChatApi`; the SSE handler in `centralChatSse`.
import { flagOn } from './envFlag'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { listConversationEvents } from './central/conversationStore'
import { ConversationError } from './central/conversationModel'
import { MockRuntime } from './central/runtime/mockRuntime'
import { OpenCodeRuntime } from './central/runtime/opencodeRuntime'
import type { RuntimeKind } from './central/runtime/centralRuntime'
import { createPortfolioReadExecutor } from './central/chat/toolExecutors'
import { StreamHub } from './central/chat/streamHub'
import {
  CentralChatError, TurnService, chatErrorStatus, listConversationSummaries, listMessages,
} from './central/chat/turnService'
import { readCappedRequestBody } from './cappedRequestBody'

export const CENTRAL_CHAT_BODY_MAX_BYTES = 64 * 1024

export interface CentralChatDeps {
  ledger?: LedgerRuntime | null
  /** Defaults to `WEBTERM_CENTRAL_CHAT`; tests pin it explicitly. */
  chatEnabled?: boolean
  /** Defaults to `WEBTERM_CENTRAL`; tests pin it explicitly. */
  centralEnabled?: boolean
  /** Defaults to `WEBTERM_CENTRAL_RUNTIME`. */
  runtimeKind?: RuntimeKind
  /** Tests may inject a ready service (and its hub). */
  service?: TurnService
  stream?: StreamHub
  now?: () => number
}

export interface ChatService {
  service: TurnService
  stream: StreamHub
  db: Database
}

/** One service/hub per database + runtime kind, so turns and subscribers share state. */
const cache = new WeakMap<object, Map<string, ChatService>>()

function buildService(db: Database, kind: RuntimeKind, now?: () => number): ChatService {
  const stream = new StreamHub({
    replay: (conversationId, afterSeq) => listConversationEvents(db, conversationId, afterSeq, 500),
  })
  const runtime = kind === 'mock'
    ? new MockRuntime({ toolExecutor: createPortfolioReadExecutor(db, { now }), stepDelayMs: 5 })
    : kind === 'opencode'
      ? new OpenCodeRuntime()
      : null
  return { service: new TurnService({ db, runtime, stream, now }), stream, db }
}

export function resolveChatService(deps: CentralChatDeps, db: Database, kind: RuntimeKind): ChatService {
  if (deps.service) return { service: deps.service, stream: deps.stream ?? new StreamHub(), db }
  let byKind = cache.get(db)
  if (!byKind) {
    byKind = new Map<string, ChatService>()
    cache.set(db, byKind)
  }
  let entry = byKind.get(kind)
  if (!entry) {
    entry = buildService(db, kind, deps.now)
    byKind.set(kind, entry)
  }
  return entry
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export function failJson(
  res: ServerResponse, code: string, message: string, extra: Record<string, unknown> = {}
): void {
  sendJson(res, chatErrorStatus(code), { error: { code, message, ...extra } })
}

export function failFromError(res: ServerResponse, err: unknown): void {
  if (err instanceof CentralChatError) {
    const activeTurnId = (err as CentralChatError & { activeTurnId?: string | null }).activeTurnId
    failJson(res, err.code, err.message, activeTurnId === undefined ? {} : { activeTurnId })
    return
  }
  if (err instanceof ConversationError) {
    const code = err.code === 'invalid_conversation' ? err.code : 'invalid_body'
    failJson(res, code, err.message)
    return
  }
  failJson(res, 'central_chat_internal', 'central chat failed')
}

export function methodNotAllowed(res: ServerResponse, method: string): void {
  sendJson(res, 405, { error: { code: 'method_not_allowed', message: method } })
}

export function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

export function positiveInteger(raw: string | null): number | null | undefined {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** SSE cursors are non-negative: `Last-Event-ID: 0` legitimately means "replay all". */
export function nonNegativeInteger(raw: string | null): number | null | undefined {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

function parseBody(raw: string): { clientMessageId: string; text: string } | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const body = value as Record<string, unknown>
    if (typeof body['clientMessageId'] !== 'string' || typeof body['text'] !== 'string') return null
    return { clientMessageId: body['clientMessageId'], text: body['text'] }
  } catch {
    return null
  }
}

export function handleHealth(res: ServerResponse, kind: RuntimeKind, db: Database | null): void {
  sendJson(res, 200, { runtime: kind, chat: true, ledger: db !== null })
}

export function handleConversations(res: ServerResponse, db: Database, now?: number): void {
  try {
    sendJson(res, 200, { items: listConversationSummaries(db, now) })
  } catch (err) {
    failFromError(res, err)
  }
}

export function handleMessagesGet(
  res: ServerResponse, db: Database, conversationId: string, url: URL
): void {
  const limit = positiveInteger(url.searchParams.get('limit'))
  const before = positiveInteger(url.searchParams.get('before'))
  if (limit === null) return failJson(res, 'invalid_limit', 'limit must be a positive integer')
  if (before === null) return failJson(res, 'invalid_cursor', 'before must be a positive integer')
  try {
    sendJson(res, 200, listMessages(db, conversationId, {
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
    }))
  } catch (err) {
    failFromError(res, err)
  }
}

export async function handleMessagesPost(
  req: IncomingMessage, res: ServerResponse, chat: ChatService, conversationId: string
): Promise<void> {
  const read = await readCappedRequestBody(req, CENTRAL_CHAT_BODY_MAX_BYTES)
  if (!read.ok) {
    const code = read.reason === 'too_large' ? 'payload_too_large' : 'invalid_body'
    sendJson(res, read.reason === 'too_large' ? 413 : 400, { error: { code, message: read.reason } })
    return
  }
  const body = parseBody(read.body)
  if (!body) return failJson(res, 'invalid_body', 'body must be {clientMessageId,text}')
  try {
    const result = chat.service.submit({ conversationId, ...body })
    sendJson(res, 202, result.response)
    void result.done.catch(() => undefined)
  } catch (err) {
    failFromError(res, err)
  }
}

export function handleCancel(res: ServerResponse, chat: ChatService, turnId: string): Promise<void> {
  return chat.service.cancel(turnId).then(
    (turn) => sendJson(res, 200, turn),
    (err: unknown) => failFromError(res, err)
  )
}
