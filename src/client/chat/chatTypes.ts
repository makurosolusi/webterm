// Shared chat wire + view types for the central agent panel (RND/11 §3-§4).
//
// The server owns the canonical ordering and all identity fields. These types only describe
// what the browser reads and renders: a conversation summary, a persisted message, and the SSE
// frames that mutate the local view. Nothing here computes authority (no digest, nonce, actor).
import type { RequestOptions } from '../inboxTypes'

export type ChatRole = 'human' | 'assistant' | 'tool' | 'system'
export type ChatMessageState = 'streaming' | 'complete' | 'failed' | 'cancelled' | 'stale'
export type ChatTurnStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled'
export type ChatToolState =
  | 'requested' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'denied' | 'cancelled'

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string; name: string; state: ChatToolState; args?: unknown; result?: unknown }
  | { type: 'approval'; approvalId: string; state: ChatToolState }
  | { type: 'error'; code: string; message: string }
  | { type: 'notice'; text: string }
  /** Attached image: `data` (base64) on the optimistic echo, `ref` (served by the messages route) in history. */
  | { type: 'image'; mediaType: string; ref?: string; data?: string }
  /** Attached text file: name, byte size, `data` (base64) on the optimistic echo, `ref` of the stored copy in history. */
  | { type: 'file'; name: string; size: number; ref?: string; data?: string }

/** A reply's turn usage (server `RuntimeUsage`): what the cost chip shows. */
export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMicros: number
  model?: string
  tier?: string
  effort?: string
}

/** One message as rendered. `seq` is null only for the optimistic human echo. */
export interface ChatMessage {
  id: string
  role: ChatRole
  seq: number | null
  state: ChatMessageState
  parts: ChatPart[]
  clientMessageId?: string
  turnId?: string
  /** True until the server's `message.created` frame replaces this row. */
  optimistic?: boolean
  /** Assistant replies: the turn's usage, from history or the `done` frame. */
  usage?: ChatUsage
  /** Server time (epoch ms) the row was stored; absent on the optimistic echo. */
  createdAt?: number
}

export interface ChatConversation {
  id: string
  scope: string
  projectId: string | null
  activeTurnId: string | null
  lastEventSeq: number
  lastMessageSeq: number
  updatedAt: number
  /** First human message, trimmed by the server; null until the first send. */
  title: string | null
}

/** `nextOffset` null = no older conversations. */
export interface ChatConversationPage {
  items: ChatConversation[]
  nextOffset: number | null
}

export interface ChatEvent {
  seq: number
  type: string
  conversationId: string
  turnId?: string
  messageId?: string
  payload?: unknown
  createdAt: number
}

export type ChatStreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SendMessageInput {
  clientMessageId: string
  text: string
  replyTo?: string
  /** Base64 images (Agent Chat limits); the server refuses them on a runtime that cannot read images. */
  images?: Array<{ mediaType: string; data: string } | { ref: string }>
  /** Base64 UTF-8 text files, inlined into the prompt server-side; `ref` resends a stored one (Retry). */
  files?: Array<{ name: string; data: string } | { name: string; ref: string }>
}

export interface SendMessageResult {
  messageId: string
  seq: number
  turnId: string
  status: ChatTurnStatus
}

export interface CancelTurnResult {
  status: ChatTurnStatus
}

export interface ChatStreamHandlers {
  onEvent: (event: ChatEvent) => void
  onStatus: (status: ChatStreamStatus) => void
}

export interface ChatStreamOptions extends ChatStreamHandlers {
  /** Replay cursor; the server also accepts it as `?after=`. */
  after?: number
  /** Injected in tests; defaults to the browser's `EventSource`. */
  createSource?: (url: string) => ChatEventSource
}

/** The subset of `EventSource` this client uses, so a fake needs no DOM. */
export interface ChatEventSource {
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void
  removeEventListener?: (type: string, listener: (event: MessageEvent) => void) => void
  close: () => void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

export interface ChatStream {
  close: () => void
}

/** Stable surface the panel needs. Tests pass a fake; defaults live in `../chatApi`. */
export interface ChatClient {
  /** One page, newest first; `offset` from the previous page's `nextOffset`. */
  listConversations: (opts?: RequestOptions & { offset?: number }) => Promise<ChatConversationPage>
  /** A new, empty chat (fresh Claude session server-side). */
  createConversation: (opts?: RequestOptions) => Promise<ChatConversation>
  listMessages: (conversationId: string, opts?: RequestOptions) => Promise<ChatMessage[]>
  sendMessage: (
    conversationId: string,
    input: SendMessageInput,
    opts?: RequestOptions
  ) => Promise<SendMessageResult>
  cancelTurn: (turnId: string, opts?: RequestOptions) => Promise<CancelTurnResult>
}

export const GLOBAL_CONVERSATION_ID = 'central:global'
const PROJECT_PREFIX = 'central:project:'
const CHAT_PREFIX = 'central:chat:'
const ACTIVE: readonly ChatTurnStatus[] = ['queued', 'running', 'awaiting_approval']

/** True while the turn holds the conversation lock. */
export function isActiveTurnStatus(status: ChatTurnStatus | null): boolean {
  return status !== null && ACTIVE.includes(status)
}

/** Conversation list label: the project id, else the title, else "Global" / "New chat". */
export function conversationLabel(conversation: Pick<ChatConversation, 'id' | 'projectId'> & { title?: string | null }): string {
  if (conversation.projectId) return conversation.projectId
  if (conversation.title) return conversation.title
  if (conversation.id === GLOBAL_CONVERSATION_ID) return 'Global'
  if (conversation.id.startsWith(CHAT_PREFIX)) return 'New chat'
  if (conversation.id.startsWith(PROJECT_PREFIX)) return conversation.id.slice(PROJECT_PREFIX.length)
  return conversation.id
}

/** Concatenated text parts; used for aria labels and the Markdown body. */
export function messageText(message: Pick<ChatMessage, 'parts'>): string {
  return message.parts
    .filter((part): part is Extract<ChatPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/** `crypto.randomUUID` where available, local fallback elsewhere. Not a secret. */
export function newClientMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
