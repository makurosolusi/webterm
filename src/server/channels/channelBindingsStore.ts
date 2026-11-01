// Explicit bind/unbind mutations for the binding API. The store is the only writer, so an
// unbound chat stays unbound until an explicit POST succeeds.
import type { ChannelBinding } from './identity'
import {
  GROUP_ROLES,
  MAX_PROJECT_ID_CHARS,
  TELEGRAM_BINDINGS_CHANNEL,
  type BindingAudit,
  type BindingStorePort,
  type RouteResult,
} from './channelBindingsTypes'
import {
  cleanId,
  cleanText,
  emit,
  fail,
  isChannelRole,
  isGroupChat,
  isRecord,
  view,
} from './channelBindingsValidation'

/**
 * Explicitly bind one chat. Re-posting updates the binding; `created` reports which happened.
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
