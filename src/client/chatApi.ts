// Human transport client for the central chat surface (RND/11 §4).
//
// Same credential as the rest of the client API (the `wt_ui` session cookie). No capability token, no
// `actor`, no digest/nonce: web chat can never approve anything. Response shapes are parsed by
// `./chat/chatWire`; transport details live in `./chat/chatTransport`.
//
// Routes (mounted under /api/central):
//   GET  /conversations                 -> {items: Conversation[], nextOffset}  (newest first, ?limit&offset)
//   POST /conversations                 -> Conversation (201, a new empty chat)
//   GET  /conversations/:id/messages    -> {items: Message[]}        (?limit=50)
//   POST /conversations/:id/messages    -> {messageId,seq,turnId,status}  (Idempotency-Key)
//   GET  /conversations/:id/stream      -> SSE frames, `id: <seq>`
//   POST /conversations/:id/regenerate  -> {messageId,seq,turnId,status}  ({clientMessageId,messageId}; last message only)
//   POST /conversations/:id/edit        -> {messageId,seq,turnId,status}  ({clientMessageId,messageId,text}; last message only)
//   POST /turns/:id/cancel              -> {status}
import type {
  CancelTurnResult, ChatClient, ChatConversation, ChatConversationPage, ChatMessage, RerunInput, SendMessageInput,
  SendMessageResult, ChatTurnStatus,
} from './chat/chatTypes'
import type { RequestOptions } from './inboxTypes'
import { CHAT_PATH, ChatApiError, requestJson } from './chat/chatTransport'
import {
  conversationRows, messageRows, normalizeConversation, normalizeMessage,
} from './chat/chatWire'

export { CHAT_PATH, CHAT_EVENT_TYPES, ChatApiError, chatErrorMessage, isAbortError } from './chat/chatTransport'
export { openChatStream } from './chat/chatStream'
export const CHAT_MESSAGE_LIMIT = 50

export const CHAT_CONVERSATION_LIMIT = 50

export async function listConversations(
  opts: RequestOptions & { offset?: number } = {}
): Promise<ChatConversationPage> {
  const offset = opts.offset ? `&offset=${opts.offset}` : ''
  const body = await requestJson<unknown>(`${CHAT_PATH}/conversations?limit=${CHAT_CONVERSATION_LIMIT}${offset}`, {
    method: 'GET',
    signal: opts.signal,
  })
  const rows = conversationRows(body)
  if (rows === null) throw new ChatApiError('Conversation list malformed', 502, 'bad_response')
  const next = (body as { nextOffset?: unknown } | null)?.nextOffset
  return {
    items: rows.map(normalizeConversation).filter((row): row is ChatConversation => row !== null),
    nextOffset: typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? next : null,
  }
}

export async function createConversation(opts: RequestOptions & { mode?: 'skill-author'; skillTarget?: string } = {}): Promise<ChatConversation> {
  const body = await requestJson<unknown>(`${CHAT_PATH}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.skillTarget ? { skillTarget: opts.skillTarget } : {}) }),
    signal: opts.signal,
  })
  const row = normalizeConversation(body)
  if (row === null) throw new ChatApiError('New conversation malformed', 502, 'bad_response')
  return row
}

export async function listMessages(
  conversationId: string,
  opts: RequestOptions = {}
): Promise<ChatMessage[]> {
  const path = `${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${CHAT_MESSAGE_LIMIT}`
  const body = await requestJson<unknown>(path, { method: 'GET', signal: opts.signal })
  const rows = messageRows(body)
  if (rows === null) throw new ChatApiError('Message history malformed', 502, 'bad_response')
  return rows
    .map(normalizeMessage)
    .filter((row): row is ChatMessage => row !== null)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

export async function sendMessage(
  conversationId: string,
  input: SendMessageInput,
  opts: RequestOptions = {}
): Promise<SendMessageResult> {
  const text = input.text.trim()
  const attached = (input.images?.length ?? 0) + (input.files?.length ?? 0) > 0
  if (text === '' && !attached) throw new ChatApiError('Message is empty', 400, 'invalid_message')
  const body = await requestJson<unknown>(
    `${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.clientMessageId },
      body: JSON.stringify({
        clientMessageId: input.clientMessageId,
        text,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.files?.length ? { files: input.files } : {}),
      }),
      signal: opts.signal,
    }
  )
  return turnStarted(body)
}

/** The `202 {messageId,seq,turnId,status}` answer of a send, regenerate or edit. */
function turnStarted(body: unknown): SendMessageResult {
  const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  const messageId = typeof row?.messageId === 'string' ? row.messageId : ''
  const turnId = typeof row?.turnId === 'string' ? row.turnId : ''
  const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? row.seq : undefined
  if (!row || !messageId || !turnId || seq === undefined) {
    throw new ChatApiError('Send response malformed', 502, 'bad_response')
  }
  return {
    messageId,
    seq,
    turnId,
    status: typeof row.status === 'string' ? (row.status as ChatTurnStatus) : 'queued',
  }
}

/** Regenerate (same text) or Edit (`text`) of the last human message; the server supersedes the old exchange. */
export async function rerunMessage(
  conversationId: string, mode: 'regenerate' | 'edit', input: RerunInput, opts: RequestOptions = {}
): Promise<SendMessageResult> {
  const body = await requestJson<unknown>(`${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.clientMessageId },
    body: JSON.stringify(input),
    signal: opts.signal,
  })
  return turnStarted(body)
}

/** URL of a stored image of a conversation (`ref` of a history `image` part); same cookie as the rest. */
export function chatImageUrl(conversationId: string, ref: string): string {
  return `${CHAT_PATH}/conversations/${encodeURIComponent(conversationId)}/messages?image=${encodeURIComponent(ref)}`
}

export async function cancelTurn(turnId: string, opts: RequestOptions = {}): Promise<CancelTurnResult> {
  const body = await requestJson<unknown>(`${CHAT_PATH}/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: opts.signal,
  })
  const status = body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined
  return { status: typeof status === 'string' ? (status as ChatTurnStatus) : 'cancelled' }
}

/** Default client. Tests pass a fake object instead. */
export const chatApi: ChatClient = {
  listConversations,
  createConversation,
  listMessages,
  sendMessage,
  cancelTurn,
  regenerate: (conversationId, input, opts) => rerunMessage(conversationId, 'regenerate', input, opts),
  editMessage: (conversationId, input, opts) => rerunMessage(conversationId, 'edit', input, opts),
}
