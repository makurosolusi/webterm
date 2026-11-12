// Event application for the chat store: seq dedupe + message/turn/tool merging.
// Pure; `./chatStore` owns the state shape and action dispatch. Kept separate so both files stay
// inside the repo budget. The wire payload shapes are the server's `ConversationEvent` rows.
import type { ChatEvent, ChatMessage, ChatPart, ChatToolState, ChatTurnStatus } from './chatTypes'
import { isActiveTurnStatus } from './chatTypes'
import { createdMessage, normalizeParts, normalizeUsage } from './chatWire'
import type { ChatState } from './chatStore'

const TURN_STATUSES: readonly ChatTurnStatus[] = [
  'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled',
]
const TOOL_STATES: readonly ChatToolState[] = [
  'requested', 'running', 'awaiting_approval', 'succeeded', 'failed', 'denied', 'cancelled',
]

function payloadOf(event: ChatEvent): Record<string, unknown> {
  const payload = event.payload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function upsert(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) return [...messages, next]
  const copy = messages.slice()
  copy[index] = next
  return copy
}

/** The assistant row a delta/tool frame belongs to; created on demand for a new turn. */
function assistantTarget(state: ChatState, event: ChatEvent): ChatMessage {
  const id = event.messageId ?? `assistant:${event.turnId ?? 'pending'}`
  return (
    state.messages.find((message) => message.id === id) ?? {
      id,
      role: 'assistant',
      seq: null,
      state: 'streaming',
      parts: [],
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    }
  )
}

function appendText(message: ChatMessage, delta: string): ChatMessage {
  const parts = message.parts.slice()
  const last = parts[parts.length - 1]
  if (last && last.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + delta }
  else parts.push({ type: 'text', text: delta })
  return { ...message, parts, state: 'streaming' }
}

function upsertTool(message: ChatMessage, part: Extract<ChatPart, { type: 'tool' }>): ChatMessage {
  const parts = message.parts.slice()
  const index = parts.findIndex((candidate) => candidate.type === 'tool' && candidate.toolCallId === part.toolCallId)
  if (index === -1) parts.push(part)
  else parts[index] = { ...(parts[index] as Extract<ChatPart, { type: 'tool' }>), ...part }
  return { ...message, parts }
}

function messageCreated(state: ChatState, event: ChatEvent): ChatState {
  const message = createdMessage(event.payload)
  if (!message) return state
  const clientMessageId = message.clientMessageId
  // The optimistic echo has a local id, so it is matched by clientMessageId and replaced
  // outright, not upserted by the new server id (which would leave two rows).
  const optimisticIndex = clientMessageId
    ? state.messages.findIndex((candidate) => candidate.clientMessageId === clientMessageId)
    : -1
  if (optimisticIndex !== -1) {
    const copy = state.messages.slice()
    copy[optimisticIndex] = message
    return { ...state, messages: copy }
  }
  const known = state.messages.some((candidate) => candidate.id === message.id)
  return { ...state, messages: known ? upsert(state.messages, message) : [...state.messages, message] }
}

function partDelta(state: ChatState, event: ChatEvent): ChatState {
  const payload = payloadOf(event)
  const delta = textField(payload.text) ?? textField(payload.delta)
  if (delta === undefined) return state
  return { ...state, messages: upsert(state.messages, appendText(assistantTarget(state, event), delta)) }
}

function partCompleted(state: ChatState, event: ChatEvent): ChatState {
  const payload = payloadOf(event)
  const target = assistantTarget(state, event)
  const parts = normalizeParts(payload.parts)
  const text = textField(payload.text)
  const next: ChatMessage = {
    ...target,
    state: 'complete',
    parts: parts.length > 0 ? parts : text !== undefined ? [{ type: 'text', text }] : target.parts,
  }
  return { ...state, messages: upsert(state.messages, next) }
}

function toolPart(
  payload: Record<string, unknown>,
  fallback: ChatToolState
): Extract<ChatPart, { type: 'tool' }> | null {
  const toolCallId = textField(payload.toolCallId) ?? textField(payload.id)
  if (!toolCallId) return null
  const raw = payload.state
  const resolved = TOOL_STATES.includes(raw as ChatToolState) ? (raw as ChatToolState) : fallback
  return {
    type: 'tool',
    toolCallId,
    name: textField(payload.name) ?? 'tool',
    state: resolved,
    // Wire names: `tool.requested` carries `input`, `tool.completed` carries `output`.
    ...((payload.args ?? payload.input) === undefined ? {} : { args: payload.args ?? payload.input }),
    ...((payload.result ?? payload.output) === undefined ? {} : { result: payload.result ?? payload.output }),
  }
}

function tool(state: ChatState, event: ChatEvent, fallback: ChatToolState): ChatState {
  const payload = payloadOf(event)
  // `tool.completed {ok}` is the server's terminal signal; `errorCode:'cancelled'` narrows it.
  const completed: ChatToolState = payload.ok === false
    ? payload.errorCode === 'cancelled' ? 'cancelled' : 'failed'
    : fallback
  const part = toolPart(payload, completed)
  if (!part) return state
  const target = assistantTarget(state, event)
  return { ...state, messages: upsert(state.messages, upsertTool(target, part)) }
}

function turnStatus(state: ChatState, event: ChatEvent): ChatState {
  const payload = payloadOf(event)
  const raw = textField(payload.status) ?? textField(payload.turnStatus)
  if (!TURN_STATUSES.includes(raw as ChatTurnStatus)) return state
  const status = raw as ChatTurnStatus
  return {
    ...state,
    turnStatus: status,
    activeTurnId: isActiveTurnStatus(status) ? event.turnId ?? state.activeTurnId : null,
    // `done` would otherwise settle a still-streaming reply of a failed turn as `complete`.
    ...(status === 'cancelled' || status === 'failed'
      ? {
          messages: state.messages.map((message) =>
            message.state === 'streaming' ? { ...message, state: status } : message
          ),
        }
      : {}),
  }
}

/** Reason on the failed reply itself (same `error` part the server persists), not a detached banner. */
function turnError(state: ChatState, event: ChatEvent): ChatState {
  const payload = payloadOf(event)
  const target = assistantTarget(state, event)
  const part: ChatPart = {
    type: 'error',
    code: textField(payload.code) ?? 'error',
    message: textField(payload.message) ?? 'The turn failed.',
  }
  const parts = target.parts.some((p) => p.type === 'error') ? target.parts : [...target.parts, part]
  return { ...state, messages: upsert(state.messages, { ...target, parts, state: 'failed' }) }
}

/** Runtime note (e.g. a fresh Claude session) shown on the reply, ahead of its text, once. */
function notice(state: ChatState, event: ChatEvent): ChatState {
  const text = textField(payloadOf(event).text)
  if (text === undefined) return state
  const target = assistantTarget(state, event)
  if (target.parts.some((p) => p.type === 'notice' && p.text === text)) return state
  return { ...state, messages: upsert(state.messages, { ...target, parts: [{ type: 'notice', text }, ...target.parts] }) }
}

/** `approval.*` frame state → the part's (tool card) state vocabulary the server persists. */
const APPROVAL_STATE: Record<string, ChatToolState> = {
  pending: 'awaiting_approval', approved: 'succeeded', rejected: 'denied', expired: 'cancelled',
}

/** Live gate state: updates the part wherever it is, or adds it to the turn's reply. */
function approval(state: ChatState, event: ChatEvent): ChatState {
  const payload = payloadOf(event)
  const approvalId = textField(payload.approvalId)
  const next = APPROVAL_STATE[textField(payload.state) ?? '']
  if (!approvalId || !next) return state
  const part: ChatPart = { type: 'approval', approvalId, state: next }
  const owner = state.messages.find((m) => m.parts.some((p) => p.type === 'approval' && p.approvalId === approvalId))
  const target = owner ?? assistantTarget(state, event)
  const parts = owner
    ? target.parts.map((p) => (p.type === 'approval' && p.approvalId === approvalId ? part : p))
    : [...target.parts, part]
  return { ...state, messages: upsert(state.messages, { ...target, parts }) }
}

function applyOnce(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'message.created':
      return messageCreated(state, event)
    case 'part.delta':
      return partDelta(state, event)
    case 'part.completed':
      return partCompleted(state, event)
    case 'tool.requested':
      return tool(state, event, 'requested')
    case 'tool.completed':
      return tool(state, event, 'succeeded')
    case 'turn.status':
      return turnStatus(state, event)
    case 'error':
      return turnError(state, event)
    case 'notice':
      return notice(state, event)
    case 'message.superseded': {
      // Regenerate / Edit: the old exchange leaves the thread; its replacement follows as `message.created`.
      const ids = payloadOf(event).messageIds
      const gone = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
      return { ...state, messages: state.messages.filter((m) => !gone.has(m.id)) }
    }
    case 'approval.requested':
    case 'approval.updated':
      return approval(state, event)
    case 'done': {
      const usage = normalizeUsage(payloadOf(event).usage)
      return {
        ...state,
        activeTurnId: null,
        messages: state.messages.map((row) => {
          const settled = row.state === 'streaming' ? { ...row, state: 'complete' as const } : row
          return usage && row.id === event.messageId ? { ...settled, usage } : settled
        }),
      }
    }
    default:
      return state
  }
}

/** Dedupe first: a frame at or below the cursor is a replay and must not mutate the view. */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  if (event.seq <= state.lastEventSeq) return state
  return applyOnce({ ...state, lastEventSeq: event.seq }, event)
}
