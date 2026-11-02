// `/api/channels/telegram/pending`: GET lists, DELETE `/:chatId` dismisses. Authorization is the
// caller's job (index.ts runs the root-token gate before handleApi), same as the bindings API.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TELEGRAM_BINDINGS_CHANNEL } from './channelBindingsTypes'
import { cleanId } from './channelBindingsValidation'
import { writeJson } from './channelHttp'
import { PENDING_CHAT_LIMIT, type PendingChatStore } from './channelPending'

export const TELEGRAM_PENDING_PATH = '/api/channels/telegram/pending'
const DEFAULT_PAGE = 50

function pageSize(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, PENDING_CHAT_LIMIT) : DEFAULT_PAGE
}

function chatIdFrom(rest: string): string | null {
  try {
    return cleanId(decodeURIComponent(rest))
  } catch {
    return null // malformed percent-encoding
  }
}

/** True when this handler owns the request (path matched), false otherwise. */
export function handleChannelPendingApi(
  req: IncomingMessage,
  res: ServerResponse,
  pending: PendingChatStore
): boolean {
  const url = new URL(req.url || '/', 'http://x')
  const path = url.pathname
  if (path !== TELEGRAM_PENDING_PATH && !path.startsWith(`${TELEGRAM_PENDING_PATH}/`)) return false
  req.resume() // no body is ever read; drain so keep-alive is not left half-consumed
  const method = (req.method ?? '').toUpperCase()

  if (path === TELEGRAM_PENDING_PATH) {
    if (method !== 'GET') return methodNotAllowed(res, 'GET')
    const { items, total } = pending.list(pageSize(url.searchParams.get('limit')))
    writeJson(res, 200, { channel: TELEGRAM_BINDINGS_CHANNEL, total, items })
    return true
  }
  if (method !== 'DELETE') return methodNotAllowed(res, 'DELETE')
  const chatId = chatIdFrom(path.slice(TELEGRAM_PENDING_PATH.length + 1))
  if (chatId === null) {
    writeJson(res, 400, { error: 'invalid_chat_id' })
  } else if (!pending.remove(chatId)) {
    writeJson(res, 404, { error: 'unknown_pending' })
  } else {
    writeJson(res, 200, { ok: true, chatId })
  }
  return true
}

function methodNotAllowed(res: ServerResponse, allow: string): true {
  writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: allow })
  return true
}
