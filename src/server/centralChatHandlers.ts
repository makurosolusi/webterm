// Central chat request handlers (RND/08 §7, RND/13 §4 C1). Owns the service cache,
// JSON/error envelopes, body intake (capped, attachments included), and the non-SSE handlers. The route
// matcher/flag gate stays in `centralChatApi`; the SSE handler in `centralChatSse`.
import { flagOn } from './envFlag'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { listConversationEvents } from './central/conversationStore'
import { ConversationError } from './central/conversationModel'
import { activeCa2 } from './central/ca2Active'
import { createContextAssembler } from './central/context/contextAssembler'
import { createCentralSummarize } from './central/context/checkpointLlm'
import { MockRuntime } from './central/runtime/mockRuntime'
import { OpenCodeRuntime } from './central/runtime/opencodeRuntime'
import { ClaudeRuntime } from './central/runtime/claudeRuntime'
import type { ClaudeRuntimeOptions } from './central/runtime/claudeOptions'
import { claudePreflightOf, type RuntimeReadiness } from './centralChatHealth'
import type { RuntimeKind } from './central/runtime/centralRuntime'
import { createPortfolioReadExecutor } from './central/chat/toolExecutors'
import { StreamHub } from './central/chat/streamHub'
import {
  CentralChatError, TurnService, chatErrorStatus, listConversationSummaries, listMessages,
} from './central/chat/turnService'
import { createChatConversation } from './central/chat/turnPersistence'
import { readCappedRequestBody } from './cappedRequestBody'
import { createLogger } from './logs'
import { AGENT_CHAT_SEND_BODY_MAX_BYTES } from './agentChat/agentChat.route.attach'
import { CENTRAL_FILES_TOTAL_BYTES } from '../shared/centralAttach'
import { type CentralAttachments, parseAttachments, readImage } from './central/chat/chatAttachments'

/** Bytes of a send body: Agent Chat's image budget, the text files as base64, and the text. */
export const CENTRAL_CHAT_BODY_MAX_BYTES = AGENT_CHAT_SEND_BODY_MAX_BYTES + Math.ceil(CENTRAL_FILES_TOTAL_BYTES / 3) * 4 + 64 * 1024
/** Browser cache of a stored image: its reference is its content hash, so it never changes. */
const IMAGE_CACHE = 'private, max-age=86400'

export interface CentralChatDeps {
  ledger?: LedgerRuntime | null
  /** Defaults to the `central` capability; tests pin it explicitly. */
  chatEnabled?: boolean
  /** Defaults to the `central` capability; tests pin it explicitly. */
  centralEnabled?: boolean
  /** Defaults to `WEBTERM_CENTRAL_RUNTIME`. */
  runtimeKind?: RuntimeKind
  /** Tests may inject a ready service (and its hub). */
  service?: TurnService
  stream?: StreamHub
  now?: () => number
  /** Tests inject a fake executable and a preflight for `claude`; default is the real CLI + shared probe. */
  claudeOptions?: ClaudeRuntimeOptions
}

export interface ChatService {
  service: TurnService
  stream: StreamHub
  db: Database
}

/** One service/hub per database + runtime kind, so turns and subscribers share state. */
const log = createLogger('central')
const cache = new WeakMap<object, Map<string, ChatService>>()

function buildService(db: Database, kind: RuntimeKind, deps: Pick<CentralChatDeps, 'now' | 'claudeOptions'>): ChatService {
  const { now } = deps
  const stream = new StreamHub({
    replay: (conversationId, afterSeq) => listConversationEvents(db, conversationId, afterSeq, 500),
  })
  const runtime = kind === 'mock'
    ? new MockRuntime({ toolExecutor: createPortfolioReadExecutor(db, { now }), stepDelayMs: 5 })
    : kind === 'opencode'
      ? new OpenCodeRuntime()
      : kind === 'claude'
        ? new ClaudeRuntime({ ...deps.claudeOptions, preflight: claudePreflightOf(deps.claudeOptions) })
        : null
  // With CA2 armed on this db, retrieval uses its memory provider; the assembler delegates to the
  // legacy path on its own when the checkpoint flag is off, so flags-off behaviour is unchanged.
  const ca2 = activeCa2()
  const armed = ca2 && ca2.db === db ? ca2 : null
  // Armed: checkpoints get the model summarizer near rotation (rolling summary below it, deterministic fallback
  // on failure; F5-c), so `WEBTERM_CENTRAL_CHECKPOINT` never idles. Tool calls are guarded where they run (mcp.central.ts).
  const wiring = armed
    ? { context: createContextAssembler({ memory: armed.memory }), summarize: createCentralSummarize() }
    : {}
  return { service: new TurnService({ db, runtime, stream, now, ...wiring }), stream, db }
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
    entry = buildService(db, kind, deps)
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
  // Unexpected: the client gets a stable code, the log keeps the cause (redacted by the log gate).
  log.error('central.chat_failed', 'central chat request failed', { error: err instanceof Error ? err.message : String(err) })
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

type SendBody = { clientMessageId: string; text: string; attachments: CentralAttachments }

function parseBody(raw: string): SendBody | { reason: string } | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (typeof body['clientMessageId'] !== 'string' || typeof body['text'] !== 'string') return null
  const attachments = parseAttachments(body)
  if ('reason' in attachments) return attachments
  return { clientMessageId: body['clientMessageId'], text: body['text'], attachments }
}

export function handleHealth(
  res: ServerResponse, kind: RuntimeKind, db: Database | null, readiness: RuntimeReadiness
): void {
  sendJson(res, 200, { runtime: kind, chat: true, ledger: db !== null, ...readiness })
}

export function handleConversations(res: ServerResponse, db: Database, url: URL, now?: number): void {
  const limit = positiveInteger(url.searchParams.get('limit'))
  const offset = nonNegativeInteger(url.searchParams.get('offset'))
  if (limit === null) return failJson(res, 'invalid_limit', 'limit must be a positive integer')
  if (offset === null) return failJson(res, 'invalid_cursor', 'offset must be a non-negative integer')
  try {
    sendJson(res, 200, listConversationSummaries(db, {
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      ...(now === undefined ? {} : { now }),
    }))
  } catch (err) {
    failFromError(res, err)
  }
}

/** `POST /conversations`: a new empty chat (body ignored), 201 with its list row. */
export function handleCreateConversation(res: ServerResponse, db: Database, now?: number): void {
  try {
    sendJson(res, 201, createChatConversation(db, now))
  } catch (err) {
    failFromError(res, err)
  }
}

export function handleMessagesGet(
  res: ServerResponse, db: Database, conversationId: string, url: URL
): void {
  const image = url.searchParams.get('image')
  if (image !== null) return sendImage(res, conversationId, image)
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
  if ('reason' in body) return failJson(res, 'invalid_attachment', body.reason)
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

/** `GET messages?image=<ref>`: one stored image of this conversation as its bytes (ref from an `image` part). */
function sendImage(res: ServerResponse, conversationId: string, ref: string): void {
  let img: ReturnType<typeof readImage>
  try {
    img = readImage(conversationId, ref)
  } catch (err) {
    return failFromError(res, err)
  }
  if (!img) return sendJson(res, 404, { error: { code: 'image_not_found', message: 'No such image in this conversation.' } })
  res.statusCode = 200
  res.setHeader('Content-Type', img.mediaType)
  res.setHeader('Content-Length', img.bytes.length)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', IMAGE_CACHE)
  res.end(img.bytes)
}
