// Pure wire normalization for the chat API. The server contract is RND/11 §4; these helpers
// validate only what the UI consumes and drop malformed rows instead of crashing a whole thread.
// No transport, no React, no authority: every identity/digest field stays server-owned.
import type {
  ChatConversation, ChatEvent, ChatMessage, ChatMessageState, ChatPart, ChatRole, ChatToolState, ChatUsage,
} from './chatTypes'

const ROLES: readonly ChatRole[] = ['human', 'assistant', 'tool', 'system']
const MESSAGE_STATES: readonly ChatMessageState[] = ['streaming', 'complete', 'failed', 'cancelled', 'stale']
const TOOL_STATES: readonly ChatToolState[] = [
  'requested', 'running', 'awaiting_approval', 'succeeded', 'failed', 'denied', 'cancelled',
]

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const optionalText = (value: unknown): string | undefined => text(value)

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function rowsOf(body: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return null
  const row = body as Record<string, unknown>
  for (const key of keys) {
    if (Array.isArray(row[key])) return row[key] as unknown[]
  }
  return null
}

/** `{items}` / `{conversations}` / bare array. */
export function conversationRows(body: unknown): unknown[] | null {
  return rowsOf(body, ['items', 'conversations'])
}

/** `{items}` / `{messages}` / bare array. */
export function messageRows(body: unknown): unknown[] | null {
  return rowsOf(body, ['items', 'messages'])
}

export function normalizeConversation(raw: unknown): ChatConversation | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = optionalText(row.id)
  if (!id) return null
  const scope = optionalText(row.scope) ?? ''
  return {
    id,
    scope,
    projectId: optionalText(row.projectId) ?? null,
    activeTurnId: optionalText(row.activeTurnId) ?? null,
    lastEventSeq: finite(row.lastEventSeq) ?? 0,
    lastMessageSeq: finite(row.lastMessageSeq) ?? 0,
    updatedAt: finite(row.updatedAt) ?? 0,
    title: optionalText(row.title) ?? null,
  }
}

export function normalizeToolState(value: unknown): ChatToolState {
  if (value === 'queued') return 'requested'
  return TOOL_STATES.includes(value as ChatToolState) ? (value as ChatToolState) : 'running'
}

function normalizePart(raw: unknown): ChatPart | null {
  if (!raw || typeof raw !== 'object') return null
  const part = raw as Record<string, unknown>
  if (part.type === 'text') {
    const value = text(part.text)
    return value === undefined ? null : { type: 'text', text: value }
  }
  if (part.type === 'error') {
    return {
      type: 'error',
      code: optionalText(part.code) ?? 'error',
      message: optionalText(part.message) ?? 'The turn failed.',
    }
  }
  if (part.type === 'notice') {
    const value = optionalText(part.text)
    return value === undefined ? null : { type: 'notice', text: value }
  }
  if (part.type === 'image') {
    const mediaType = optionalText(part.mediaType)
    const ref = optionalText(part.ref)
    // A ref goes into a URL: only the server's content-hash shape is taken.
    return mediaType?.startsWith('image/') && ref && /^[0-9a-f]{64}$/.test(ref) ? { type: 'image', mediaType, ref } : null
  }
  if (part.type === 'file') {
    const name = optionalText(part.name)
    const size = finite(part.size)
    const ref = optionalText(part.ref)
    if (!name || size === undefined) return null
    return { type: 'file', name, size, ...(ref && /^[0-9a-f]{64}$/.test(ref) ? { ref } : {}) }
  }
  if (part.type === 'tool') {
    const toolCallId = optionalText(part.toolCallId)
    if (!toolCallId) return null
    return {
      type: 'tool',
      toolCallId,
      name: optionalText(part.name) ?? 'tool',
      state: normalizeToolState(part.state),
      ...(part.args === undefined ? {} : { args: part.args }),
      ...(part.result === undefined ? {} : { result: part.result }),
    }
  }
  if (part.type === 'approval') {
    const approvalId = optionalText(part.approvalId)
    if (!approvalId) return null
    return { type: 'approval', approvalId, state: normalizeToolState(part.state) }
  }
  return null
}

export function normalizeParts(raw: unknown): ChatPart[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizePart).filter((part): part is ChatPart => part !== null)
}

/** A persisted `Message` row. `seq` is required: an unsequenced row cannot be ordered. */
export function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = optionalText(row.id)
  const seq = finite(row.seq)
  if (!id || seq === undefined) return null
  const role = ROLES.includes(row.role as ChatRole) ? (row.role as ChatRole) : 'assistant'
  const state = MESSAGE_STATES.includes(row.state as ChatMessageState)
    ? (row.state as ChatMessageState)
    : 'complete'
  const usage = normalizeUsage(row.usage)
  return {
    id,
    role,
    seq,
    state,
    parts: normalizeParts(row.parts),
    ...(optionalText(row.clientMessageId) ? { clientMessageId: optionalText(row.clientMessageId) } : {}),
    ...(optionalText(row.turnId) ? { turnId: optionalText(row.turnId) } : {}),
    ...(usage ? { usage } : {}),
    ...(finite(row.createdAt) ? { createdAt: finite(row.createdAt) } : {}),
  }
}

/** A turn's usage object; null unless it carries a numeric cost. */
export function normalizeUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (typeof u.costMicros !== 'number') return null
  return {
    inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens), costMicros: num(u.costMicros),
    ...(optionalText(u.model) ? { model: optionalText(u.model) } : {}),
    ...(optionalText(u.tier) ? { tier: optionalText(u.tier) } : {}),
    ...(optionalText(u.effort) ? { effort: optionalText(u.effort) } : {}),
  }
}

/**
 * One SSE frame. `id:` (lastEventId) is the replay cursor; the JSON body may also carry `seq`.
 * A frame without a usable seq is dropped: applying it would corrupt dedupe.
 */
export function parseEventFrame(
  type: string,
  data: string,
  lastEventId: string,
  fallbackConversationId: string
): ChatEvent | null {
  let payload: unknown = null
  try {
    payload = data === '' ? null : JSON.parse(data)
  } catch {
    return null
  }
  const row = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const seq = finite(row.seq) ?? finite(Number(lastEventId))
  if (seq === undefined || !Number.isInteger(seq) || seq <= 0) return null
  const conversationId = optionalText(row.conversationId) ?? fallbackConversationId
  const turnId = optionalText(row.turnId)
  const messageId = optionalText(row.messageId)
  return {
    seq,
    type: optionalText(row.type) ?? type,
    conversationId,
    ...(turnId === undefined ? {} : { turnId }),
    ...(messageId === undefined ? {} : { messageId }),
    // The whole body doubles as the payload, matching the server's ConversationEvent shape.
    payload: row.payload === undefined ? payload : row.payload,
    createdAt: finite(row.createdAt) ?? 0,
  }
}

/**
 * Body of `message.created`. The server emits `{messageId, seq, role, parts}` (no nested
 * `message`), so `messageId` is mapped to the view's `id`; a nested row is also accepted for
 * adapters that send the full message.
 */
export function createdMessage(payload: unknown): ChatMessage | null {
  if (!payload || typeof payload !== 'object') return null
  const outer = payload as Record<string, unknown>
  const nested = outer.message
  const row =
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : { ...outer, id: outer.messageId ?? outer.id }
  const message = normalizeMessage(row)
  if (!message) return null
  // A message.created assistant row starts empty and is filled by later delta frames.
  const state = outer.state
  return {
    ...message,
    state: MESSAGE_STATES.includes(state as ChatMessageState)
      ? (state as ChatMessageState)
      : message.role === 'assistant' ? 'streaming' : 'complete',
  }
}
