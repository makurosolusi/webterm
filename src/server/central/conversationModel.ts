/**
 * P5 conversation contract (RND/08 §7, RND/11 §4): scope mapping, message/parts
 * schema, turn state machine, event types, and secret redaction. Pure only; the
 * conversation store owns SQL and sequence allocation.
 */
export const MESSAGE_ROLES = ['human', 'assistant', 'tool', 'system'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]
export const MESSAGE_STATES = ['streaming', 'complete', 'failed', 'cancelled', 'stale'] as const
export type MessageState = (typeof MESSAGE_STATES)[number]
export const TURN_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'] as const
export type TurnStatus = (typeof TURN_STATUSES)[number]
export const TOOL_STATES = ['requested', 'running', 'awaiting_approval', 'succeeded', 'failed', 'denied', 'cancelled'] as const
export type ToolCardState = (typeof TOOL_STATES)[number]
export const RISK_CLASSES = ['R0', 'R1', 'R2', 'R3'] as const
export type RiskClass = (typeof RISK_CLASSES)[number]
export const CENTRAL_EVENT_TYPES = [
  'message.created', 'part.delta', 'part.completed', 'tool.requested', 'tool.completed',
  'approval.requested', 'approval.updated', 'entity.updated', 'turn.status', 'error', 'done', 'notice',
] as const
export type CentralEventType = (typeof CENTRAL_EVENT_TYPES)[number]

/** Terminal turns free the conversation lock; every other status is active. */
const TERMINAL: readonly TurnStatus[] = ['succeeded', 'failed', 'cancelled']
const TURN_TRANSITIONS: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['awaiting_approval', 'succeeded', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string; name: string; state: ToolCardState; args?: unknown; result?: unknown; digest?: string; risk?: RiskClass }
  | { type: 'approval'; approvalId: string; state: ToolCardState; digest?: string; expiresAt?: number }
  | { type: 'error'; code: string; message: string }
  /** Runtime note shown on the reply (e.g. a fresh Claude session); never model text. */
  | { type: 'notice'; text: string }

/** `chatId` set = one of the user's extra global chats ("New chat"); unset = the default `central:global`. */
export type ConversationScope = { kind: 'global'; chatId?: string } | { kind: 'project'; projectId: string }

export type ConversationErrorCode =
  | 'invalid_scope' | 'invalid_conversation' | 'invalid_role' | 'invalid_state'
  | 'invalid_parts' | 'invalid_message' | 'invalid_turn_status' | 'invalid_event' | 'invalid_transition'
  | 'conversation_not_found' | 'message_not_found' | 'turn_not_found' | 'conversation_busy'
  | 'turn_not_active' | 'invalid_limit'

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ConversationError'
  }
}

export const GLOBAL_CONVERSATION_ID = 'central:global'
export const PROJECT_CONVERSATION_PREFIX = 'central:project:'
export const CHAT_CONVERSATION_PREFIX = 'central:chat:'
/** Server-minted chat ids (UUIDs); the strict shape keeps them safe in paths, keys and scope strings. */
const CHAT_ID = /^[A-Za-z0-9-]{1,64}$/
export const MAX_MESSAGE_CHARS = 32_000
export const MAX_CLIENT_MESSAGE_ID = 200
export const MAX_PARTS = 100
export const MAX_PART_JSON = 64_000
const MAX_ID = 200
const CONTROL = /[\u0000-\u001f\u007f]/
/** Message text may span lines: `\n` and `\t` pass, a lone `\r` and every other control char do not. */
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

function fail(code: ConversationErrorCode, message: string): never {
  throw new ConversationError(code, message)
}
function chatId(value: string): string {
  if (!CHAT_ID.test(value)) fail('invalid_conversation', 'chat id must be 1..64 letters, digits or dashes')
  return value
}
function id(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text.length > MAX_ID || CONTROL.test(text)) fail('invalid_conversation', `${label} is invalid`)
  return text
}

/** Parses `global`, `chat:<id>` or `project:<id>` into a typed scope. */
export function parseScope(raw: unknown): ConversationScope {
  if (raw === 'global') return { kind: 'global' }
  if (typeof raw === 'string' && raw.startsWith('chat:')) return { kind: 'global', chatId: chatId(raw.slice('chat:'.length)) }
  if (typeof raw === 'string' && raw.startsWith('project:')) {
    return { kind: 'project', projectId: id(raw.slice('project:'.length), 'projectId') }
  }
  fail('invalid_scope', 'scope must be "global", "chat:<id>" or "project:<id>"')
}

/** Canonical conversation id per RND/08 D8. */
export function conversationIdForScope(scope: ConversationScope): string {
  if (scope.kind === 'project') return `${PROJECT_CONVERSATION_PREFIX}${id(scope.projectId, 'projectId')}`
  return scope.chatId === undefined ? GLOBAL_CONVERSATION_ID : `${CHAT_CONVERSATION_PREFIX}${chatId(scope.chatId)}`
}

/** Inverse mapping; a non-canonical id is rejected rather than guessed. */
export function scopeFromConversationId(raw: unknown): ConversationScope {
  if (raw === GLOBAL_CONVERSATION_ID) return { kind: 'global' }
  if (typeof raw === 'string' && raw.startsWith(CHAT_CONVERSATION_PREFIX)) {
    return { kind: 'global', chatId: chatId(raw.slice(CHAT_CONVERSATION_PREFIX.length)) }
  }
  if (typeof raw === 'string' && raw.startsWith(PROJECT_CONVERSATION_PREFIX)) {
    return { kind: 'project', projectId: id(raw.slice(PROJECT_CONVERSATION_PREFIX.length), 'projectId') }
  }
  fail('invalid_conversation', `unknown conversation id ${JSON.stringify(raw)}`)
}
function pick<T extends string>(values: readonly T[], code: ConversationErrorCode, label: string, value: unknown): T {
  if (!values.includes(value as T)) fail(code, `unknown ${label} ${String(value)}`)
  return value as T
}
export const validateMessageRole = (value: unknown): MessageRole => pick(MESSAGE_ROLES, 'invalid_role', 'role', value)
export const validateMessageState = (value: unknown): MessageState => pick(MESSAGE_STATES, 'invalid_state', 'message state', value)
export const validateTurnStatus = (value: unknown): TurnStatus => pick(TURN_STATUSES, 'invalid_turn_status', 'turn status', value)
export const validateEventType = (value: unknown): CentralEventType => pick(CENTRAL_EVENT_TYPES, 'invalid_event', 'event type', value)
export function isActiveTurnStatus(value: TurnStatus): boolean {
  return !TERMINAL.includes(value)
}
export function assertTurnTransition(from: TurnStatus, to: TurnStatus): void {
  if (from !== to && !TURN_TRANSITIONS[from].includes(to)) {
    fail('invalid_transition', `turn cannot move from ${from} to ${to}`)
  }
}
export function normalizeClientMessageId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text.length > MAX_CLIENT_MESSAGE_ID || CONTROL.test(text)) {
    fail('invalid_message', `clientMessageId must be 1..${MAX_CLIENT_MESSAGE_ID} characters`)
  }
  return text
}
/** Multi-line message text: `\r\n` becomes `\n`, then 1..MAX chars without other control chars. */
function messageBody(value: unknown, code: ConversationErrorCode, label: string): string {
  const text = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
  if (text === '' || text.length > MAX_MESSAGE_CHARS) fail(code, `${label} must be 1..${MAX_MESSAGE_CHARS} characters`)
  if (TEXT_CONTROL.test(text)) fail(code, `${label} contains a control character`)
  return text
}
export function validateMessageText(value: unknown): string {
  return messageBody(value, 'invalid_message', 'text')
}

function partText(value: unknown, label: string, max = MAX_ID): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text.length > max || CONTROL.test(text)) fail('invalid_parts', `${label} is invalid`)
  return text
}
function jsonable(value: unknown, label: string): unknown {
  if (value === undefined) return undefined
  try {
    if (JSON.stringify(value).length <= MAX_PART_JSON) return value
  } catch {
    // fall through to the typed error
  }
  fail('invalid_parts', `${label} must be JSON-serializable and under ${MAX_PART_JSON} bytes`)
}
function validatePart(raw: unknown, index: number): MessagePart {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('invalid_parts', `parts[${index}] must be an object`)
  const part = raw as Record<string, unknown>
  if (part['type'] === 'text') return { type: 'text', text: messageBody(part['text'], 'invalid_parts', `parts[${index}].text`) }
  if (part['type'] === 'error') {
    return { type: 'error', code: partText(part['code'], `parts[${index}].code`), message: partText(part['message'], `parts[${index}].message`) }
  }
  if (part['type'] === 'notice') return { type: 'notice', text: partText(part['text'], `parts[${index}].text`) }
  if (part['type'] !== 'tool' && part['type'] !== 'approval') {
    fail('invalid_parts', `parts[${index}].type must be text|tool|approval|error|notice`)
  }
  const state = pick(TOOL_STATES, 'invalid_parts', `parts[${index}].state`, part['state'])
  const digest = part['digest'] === undefined ? {} : { digest: partText(part['digest'], `parts[${index}].digest`) }
  if (part['type'] === 'tool') {
    const risk = part['risk']
    if (risk !== undefined && !(RISK_CLASSES as readonly unknown[]).includes(risk)) fail('invalid_parts', `parts[${index}].risk is invalid`)
    return {
      type: 'tool',
      toolCallId: partText(part['toolCallId'], `parts[${index}].toolCallId`),
      name: partText(part['name'], `parts[${index}].name`),
      state,
      ...(risk === undefined ? {} : { risk: risk as RiskClass }),
      ...digest,
      ...(part['args'] === undefined ? {} : { args: jsonable(part['args'], `parts[${index}].args`) }),
      ...(part['result'] === undefined ? {} : { result: jsonable(part['result'], `parts[${index}].result`) }),
    }
  }
  const expiresAt = part['expiresAt']
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    fail('invalid_parts', `parts[${index}].expiresAt must be a number`)
  }
  return {
    type: 'approval',
    approvalId: partText(part['approvalId'], `parts[${index}].approvalId`),
    state,
    ...digest,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

export function validateParts(value: unknown): MessagePart[] {
  if (!Array.isArray(value) || value.length > MAX_PARTS) fail('invalid_parts', `parts must be an array of at most ${MAX_PARTS}`)
  return value.map((part, index) => validatePart(part, index))
}
