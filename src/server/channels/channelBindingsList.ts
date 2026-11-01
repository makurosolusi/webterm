// Read side of the binding API: list bound telegram chats.
import {
  TELEGRAM_BINDINGS_CHANNEL,
  type BindingAudit,
  type BindingStorePort,
  type RouteResult,
} from './channelBindingsTypes'
import { emit, fail, view } from './channelBindingsValidation'

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
