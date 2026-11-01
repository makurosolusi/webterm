// State + action dispatch for one chat conversation. Pure and synchronous: transport lives in
// `../chatApi`, rendering in `./chatMessages`, and event merging in `./chatEventReducer`.
// The server is the ordering authority; `lastEventSeq` makes a replayed SSE frame a no-op.
import type { ChatMessage, ChatTurnStatus } from './chatTypes'
import { isActiveTurnStatus } from './chatTypes'
import { applyChatEvent } from './chatEventReducer'

export type ChatStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface ChatState {
  conversationId: string
  messages: ChatMessage[]
  lastEventSeq: number
  activeTurnId: string | null
  turnStatus: ChatTurnStatus | null
  stream: ChatStreamState
  error: string | null
  hydrated: boolean
}

export type ChatAction =
  | { type: 'hydrate'; messages: ChatMessage[]; activeTurnId?: string | null }
  | { type: 'optimistic'; message: ChatMessage }
  | {
      type: 'send-ok'
      clientMessageId: string
      messageId: string
      seq: number
      turnId: string
      status: ChatTurnStatus
    }
  | { type: 'send-failed'; clientMessageId: string; error: string }
  | { type: 'busy'; activeTurnId: string | null; error: string }
  | { type: 'cancel-ok' }
  | { type: 'event'; event: Parameters<typeof applyChatEvent>[1] }
  | { type: 'stream'; status: ChatStreamState }
  | { type: 'error'; error: string | null }

export function initialChatState(conversationId: string): ChatState {
  return {
    conversationId,
    messages: [],
    lastEventSeq: 0,
    activeTurnId: null,
    turnStatus: null,
    stream: 'idle',
    error: null,
    hydrated: false,
  }
}

function patch(messages: ChatMessage[], id: string, fn: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === id)
  if (index === -1) return messages
  const copy = messages.slice()
  copy[index] = fn(copy[index])
  return copy
}

function hydrate(state: ChatState, messages: ChatMessage[], activeTurnId?: string | null): ChatState {
  const byId = new Map<string, ChatMessage>()
  for (const message of state.messages) if (!message.optimistic) byId.set(message.id, message)
  for (const message of messages) byId.set(message.id, message)
  const merged = [...byId.values()].sort(
    (a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
  )
  const optimistic = state.messages.filter((message) => message.optimistic)
  return {
    ...state,
    messages: [...merged, ...optimistic],
    hydrated: true,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
  }
}

function upsert(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) return [...messages, next]
  const copy = messages.slice()
  copy[index] = next
  return copy
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'hydrate':
      return hydrate(state, action.messages, action.activeTurnId)
    case 'optimistic':
      return { ...state, messages: upsert(state.messages, action.message), error: null }
    case 'send-ok':
      // The server's `message.created` frame can beat the POST response and (per the wire
      // contract) does not echo clientMessageId. In that case the real row already exists, so
      // the optimistic echo is dropped instead of being patched into a duplicate id.
      if (state.messages.some((message) => message.id === action.messageId && !message.optimistic)) {
        return {
          ...state,
          error: null,
          activeTurnId: isActiveTurnStatus(action.status) ? action.turnId : state.activeTurnId,
          turnStatus: action.status,
          messages: state.messages.filter((message) => message.id !== `optimistic:${action.clientMessageId}`),
        }
      }
      return {
        ...state,
        error: null,
        activeTurnId: isActiveTurnStatus(action.status) ? action.turnId : state.activeTurnId,
        turnStatus: action.status,
        messages: patch(state.messages, `optimistic:${action.clientMessageId}`, (message) => ({
          ...message,
          id: action.messageId,
          seq: action.seq,
          turnId: action.turnId,
          state: action.status === 'failed' ? 'failed' : 'complete',
          optimistic: false,
        })),
      }
    case 'send-failed':
      return {
        ...state,
        error: action.error,
        messages: patch(state.messages, `optimistic:${action.clientMessageId}`, (message) => ({
          ...message,
          state: 'failed',
        })),
      }
    case 'busy':
      return { ...state, error: action.error, activeTurnId: action.activeTurnId }
    case 'cancel-ok':
      return {
        ...state,
        activeTurnId: null,
        turnStatus: 'cancelled',
        messages: state.messages.map((message) =>
          message.state === 'streaming' ? { ...message, state: 'cancelled' as const } : message
        ),
      }
    case 'event':
      return applyChatEvent(state, action.event)
    case 'stream':
      return { ...state, stream: action.status }
    case 'error':
      return { ...state, error: action.error }
    default:
      return state
  }
}

/** Ordered for rendering: persisted rows by `seq`, optimistic rows last. */
export function orderedMessages(state: ChatState): ChatMessage[] {
  return state.messages.slice().sort((a, b) => {
    if (a.optimistic !== b.optimistic) return a.optimistic ? 1 : -1
    return (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
  })
}

export function buildOptimisticMessage(clientMessageId: string, text: string): ChatMessage {
  return {
    id: `optimistic:${clientMessageId}`,
    role: 'human',
    seq: null,
    state: 'streaming',
    parts: [{ type: 'text', text }],
    clientMessageId,
    optimistic: true,
  }
}
