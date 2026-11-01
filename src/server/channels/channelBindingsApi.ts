// Human-facing binding API (P3): GET/POST/DELETE `/api/channels/telegram/bindings`. Pure transport
// adapters around ChannelStore; root/human auth is the caller's job (index.ts does it before this
// runs). Nothing here auto-enrolls a chat: a conversation exists only after an explicit POST.
//
// Group chats are mirror/observe surfaces: they may bind `viewer` or `operator` only. Approval
// roles (`approver`, `owner`) require a private chat, because group identity is ambiguous.
// Typed RouteResult mirrors the other API modules; `null` means "not this route".
import { CHANNEL_ROLES, type ChannelBinding, type ChannelRole } from './identity'

export type RouteResult = { status: number; body: unknown }

export const TELEGRAM_BINDINGS_PATH = '/api/channels/telegram/bindings'
export const TELEGRAM_BINDINGS_CHANNEL = 'telegram'
export const GROUP_ROLES: readonly ChannelRole[] = ['viewer', 'operator']
export const MAX_PROJECT_ID_CHARS = 200
const MAX_ID_CHARS = 32
const MAX_BODY_BYTES = 16 * 1024
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export interface BindingStorePort {
  binding(channel: string, chatId: string): ChannelBinding | undefined
  bind(channel: string, chatId: string, binding: ChannelBinding): void
  unbind(channel: string, chatId: string): boolean
  listBindings(channel?: string): Array<{ channel: string; chatId: string; binding: ChannelBinding }>
}

export type BindingAction = 'list' | 'bind' | 'unbind'
export type BindingOutcome = 'ok' | 'invalid' | 'denied' | 'not_found' | 'error'

/** Optional observer hook. Contains no secret and no free text from the request body. */
export interface BindingAuditEvent {
  kind: 'channel.telegram.binding'
  action: BindingAction
  outcome: BindingOutcome
  reason?: string
  chatId?: string
  projectId?: string
  role?: string
}
export type BindingAudit = (event: BindingAuditEvent) => void

export interface TelegramBindingView {
  channel: typeof TELEGRAM_BINDINGS_CHANNEL
  chatId: string
  projectId: string
  role: ChannelRole
  userId?: string
}

function emit(audit: BindingAudit | undefined, event: BindingAuditEvent): void {
  if (!audit) return
  try {
    audit(event)
  } catch {
    // Observability must never turn a successful bind/unbind into an error response.
  }
}

function fail(status: number, error: string): RouteResult {
  return { status, body: { error } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty, bounded, no control characters. Values are stored and later echoed to the UI. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || CONTROL_CHARS.test(trimmed)) return null
  return trimmed
}

/**
 * Provider ids stay strings so 64-bit chat/user ids survive JSON. A JSON number is accepted only
 * when it is a safe integer; anything larger must arrive as a string.
 */
function cleanId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null
  }
  const text = cleanText(value, MAX_ID_CHARS)
  return text !== null && /^-?\d+$/.test(text) ? text : null
}

function isChannelRole(value: unknown): value is ChannelRole {
  return typeof value === 'string' && (CHANNEL_ROLES as readonly string[]).includes(value)
}

/** Telegram group/supergroup ids are negative; an explicit `isGroup` can also mark one. */
function isGroupChat(chatId: string, declared: unknown): boolean {
  return chatId.startsWith('-') || declared === true
}

function view(chatId: string, binding: ChannelBinding): TelegramBindingView {
  return {
    channel: TELEGRAM_BINDINGS_CHANNEL,
    chatId,
    projectId: binding.projectId,
    role: binding.role,
    ...(binding.userId === undefined ? {} : { userId: binding.userId }),
  }
}

export function listTelegramBindings(
  store: BindingStorePort,
  audit?: BindingAudit
): RouteResult {
  try {
    const items = store
      .listBindings(TELEGRAM_BINDINGS_CHANNEL)
      .map((row) => view(row.chatId, row.binding))
    emit(audit, { kind: 'channel.telegram.binding', action: 'list', outcome: 'ok' })
    return { status: 200, body: { channel: TELEGRAM_BINDINGS_CHANNEL, items } }
  } catch {
    emit(audit, { kind: 'channel.telegram.binding', action: 'list', outcome: 'error' })
    return fail(500, 'store_unavailable')
  }
}

/**
 * Explicitly bind one chat. Re-posting updates the binding; `created` reports which happened.
 * The store is the only writer, so an unbound chat stays unbound until this call succeeds.
 */
export function createTelegramBinding(
  body: unknown,
  store: BindingStorePort,
  audit?: BindingAudit
): RouteResult {
  if (!isRecord(body)) {
    emit(audit, { kind: 'channel.telegram.binding', action: 'bind', outcome: 'invalid', reason: 'invalid_body' })
    return fail(400, 'invalid_body')
  }
  const projectId = cleanText(body['projectId'], MAX_PROJECT_ID_CHARS)
  if (projectId === null) {
    emit(audit, { kind: 'channel.telegram.binding', action: 'bind', outcome: 'invalid', reason: 'invalid_project_id' })
    return fail(400, 'invalid_project_id')
  }
  const chatId = cleanId(body['chatId'])
  if (chatId === null) {
    emit(audit, { kind: 'channel.telegram.binding', action: 'bind', outcome: 'invalid', reason: 'invalid_chat_id' })
    return fail(400, 'invalid_chat_id')
  }
  const role = body['role']
  if (!isChannelRole(role)) {
    emit(audit, {
      kind: 'channel.telegram.binding',
      action: 'bind',
      outcome: 'invalid',
      reason: 'invalid_role',
      chatId,
      projectId,
    })
    return fail(400, 'invalid_role')
  }
  let userId: string | undefined
  if (body['userId'] !== undefined) {
    const parsed = cleanId(body['userId'])
    if (parsed === null) {
      emit(audit, {
        kind: 'channel.telegram.binding',
        action: 'bind',
        outcome: 'invalid',
        reason: 'invalid_user_id',
        chatId,
        projectId,
        role,
      })
      return fail(400, 'invalid_user_id')
    }
    userId = parsed
  }
  if (isGroupChat(chatId, body['isGroup']) && !GROUP_ROLES.includes(role)) {
    emit(audit, {
      kind: 'channel.telegram.binding',
      action: 'bind',
      outcome: 'denied',
      reason: 'group_approval_role_denied',
      chatId,
      projectId,
      role,
    })
    return fail(403, 'group_approval_role_denied')
  }

  try {
    const created = store.binding(TELEGRAM_BINDINGS_CHANNEL, chatId) === undefined
    const binding: ChannelBinding = {
      projectId,
      role,
      ...(userId === undefined ? {} : { userId }),
    }
    store.bind(TELEGRAM_BINDINGS_CHANNEL, chatId, binding)
    emit(audit, {
      kind: 'channel.telegram.binding',
      action: 'bind',
      outcome: 'ok',
      chatId,
      projectId,
      role,
    })
    return {
      status: created ? 201 : 200,
      body: { ok: true, created, binding: view(chatId, binding) },
    }
  } catch {
    emit(audit, {
      kind: 'channel.telegram.binding',
      action: 'bind',
      outcome: 'error',
      chatId,
      projectId,
      role,
    })
    return fail(500, 'store_unavailable')
  }
}

export function deleteTelegramBinding(
  chatIdInput: unknown,
  store: BindingStorePort,
  audit?: BindingAudit
): RouteResult {
  const chatId = cleanId(chatIdInput)
  if (chatId === null) {
    emit(audit, {
      kind: 'channel.telegram.binding',
      action: 'unbind',
      outcome: 'invalid',
      reason: 'invalid_chat_id',
    })
    return fail(400, 'invalid_chat_id')
  }
  try {
    if (!store.unbind(TELEGRAM_BINDINGS_CHANNEL, chatId)) {
      emit(audit, {
        kind: 'channel.telegram.binding',
        action: 'unbind',
        outcome: 'not_found',
        chatId,
      })
      return fail(404, 'unknown_binding')
    }
    emit(audit, { kind: 'channel.telegram.binding', action: 'unbind', outcome: 'ok', chatId })
    return { status: 200, body: { ok: true, chatId } }
  } catch {
    emit(audit, { kind: 'channel.telegram.binding', action: 'unbind', outcome: 'error', chatId })
    return fail(500, 'store_unavailable')
  }
}

/**
 * Route adapter. `readBody` is only called for POST; a body over the cap is rejected before parse.
 * Returns `null` for any other path or method so the server can continue its own dispatch.
 */
export async function channelBindingsRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  readBody: () => Promise<string>,
  store: BindingStorePort,
  audit?: BindingAudit
): Promise<RouteResult | null> {
  if (path !== TELEGRAM_BINDINGS_PATH) return null
  if (method === 'GET') return listTelegramBindings(store, audit)
  if (method === 'DELETE') return deleteTelegramBinding(params.get('chatId'), store, audit)
  if (method !== 'POST') return null

  let raw: string
  try {
    raw = await readBody()
  } catch {
    return fail(400, 'invalid_body')
  }
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'body_too_large')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    emit(audit, { kind: 'channel.telegram.binding', action: 'bind', outcome: 'invalid', reason: 'invalid_json' })
    return fail(400, 'invalid_json')
  }
  return createTelegramBinding(body, store, audit)
}
