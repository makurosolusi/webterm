// Route adapter for `/api/channels/telegram/bindings`: dispatch only, no validation logic.
import {
  TELEGRAM_BINDINGS_PATH,
  type BindingAudit,
  type BindingStorePort,
  type RouteResult,
} from './channelBindingsTypes'
import { cleanId, emit, fail, isRecord } from './channelBindingsValidation'
import { listTelegramBindings } from './channelBindingsList'
import { createTelegramBinding, deleteTelegramBinding } from './channelBindingsStore'

const MAX_BODY_BYTES = 16 * 1024

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
  audit?: BindingAudit,
  pending?: { remove(chatId: string): boolean }
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
  const result = createTelegramBinding(body, store, audit)
  // A successful bind resolves the chat's pending entry (the owner just acted on it).
  const boundId = isRecord(body) ? cleanId(body['chatId']) : null
  if (result.status < 300 && boundId !== null) pending?.remove(boundId)
  return result
}
