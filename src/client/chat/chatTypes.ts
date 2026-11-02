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
}

export interface ChatConversation {
  id: string
  scope: string
  projectId: string | null
  activeTurnId: string | null
  lastEventSeq: number
  lastMessageSeq: number
  updatedAt: number
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
  listConversations: (opts?: RequestOptions) => Promise<ChatConversation[]>
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
const ACTIVE: readonly ChatTurnStatus[] = ['queued', 'running', 'awaiting_approval']

/** True while the turn holds the conversation lock. */
export function isActiveTurnStatus(status: ChatTurnStatus | null): boolean {
  return status !== null && ACTIVE.includes(status)
}

/** Conversation list label: "Global" or the project id. */
export function conversationLabel(conversation: Pick<ChatConversation, 'id' | 'projectId'>): string {
  if (conversation.id === GLOBAL_CONVERSATION_ID) return 'Global'
  if (conversation.projectId) return conversation.projectId
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
