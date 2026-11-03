// HTTP route matcher and flag gate for central chat (RND/08 §7/§9, RND/13 §4 C1).
// Exact chat paths only. Handlers live in `centralChatHandlers` (JSON/body/cache)
// and `centralChatSse`; the transport layer already enforces root/loopback, so
// this module never reads a token and never puts one in an event or response.
//
// Flags: `WEBTERM_CENTRAL=on` AND `WEBTERM_CENTRAL_CHAT=on`. Chat off means "not
// mounted" (404 by the fallback). Runtime off answers 503 `central_runtime_off`; `claude` builds a
// real runtime and reports an unready CLI as a failed turn (`runtime_unavailable`), never as 503.
import { isEnabled } from './featureCapabilities.runtime'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import { claudePreflightOf, runtimeReadiness } from './centralChatHealth'
import { centralRuntimeKind } from './central/runtime/runtimeFlag'
import type { RuntimeKind } from './central/runtime/centralRuntime'
import {
  CENTRAL_CHAT_BODY_MAX_BYTES, type CentralChatDeps, decodeSegment, failJson,
  handleCancel, handleConversations, handleHealth, handleMessagesGet, handleMessagesPost,
  methodNotAllowed, resolveChatService, sendJson,
} from './centralChatHandlers'
import { handleStream } from './centralChatSse'

export { CENTRAL_CHAT_BODY_MAX_BYTES }
export type { CentralChatDeps }

const CONVERSATIONS_PATH = '/api/central/conversations'
const MESSAGES = /^\/api\/central\/conversations\/([^/]+)\/messages$/
const STREAM = /^\/api\/central\/conversations\/([^/]+)\/stream$/
const CANCEL = /^\/api\/central\/turns\/([^/]+)\/cancel$/
const HEALTH_PATH = '/api/central/health'

/** True only for the exact chat families; `false` keeps falling through to 404. */
export function isCentralChatPath(path: string): boolean {
  return path === CONVERSATIONS_PATH || path === HEALTH_PATH ||
    MESSAGES.test(path) || STREAM.test(path) || CANCEL.test(path)
}

/** `true` = response taken over (including SSE). */
export async function centralChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CentralChatDeps = {}
): Promise<boolean> {
  const path = url.pathname
  if (!isCentralChatPath(path)) return false
  // Chat ikut kemampuan central (turunan), jadi kedua gerbang membaca kemampuan yang sama.
  const chatOn = deps.chatEnabled ?? isEnabled('central')
  const centralOn = deps.centralEnabled ?? isEnabled('central')
  if (!chatOn || !centralOn) return false

  const method = req.method || 'GET'
  const kind: RuntimeKind = deps.runtimeKind ?? centralRuntimeKind()
  const db: Database | null = deps.ledger?.db ?? null

  if (path === HEALTH_PATH) {
    if (method !== 'GET') return methodNotAllowed(res, method), true
    handleHealth(res, kind, db, await runtimeReadiness(kind, claudePreflightOf(deps.claudeOptions)))
    return true
  }
  if (db === null) {
    sendJson(res, 503, { error: { code: 'ledger_off', message: 'ledger is off' } })
    return true
  }
  const chat = resolveChatService(deps, db, kind)

  const cancelMatch = CANCEL.exec(path)
  if (cancelMatch) {
    if (method !== 'POST') return methodNotAllowed(res, method), true
    // The cancel body is ignored (`{}`); drain it so keep-alive is not desynced.
    req.resume()
    const turnId = decodeSegment(cancelMatch[1] ?? '')
    if (turnId === null) return failJson(res, 'invalid_body', 'invalid turn id'), true
    await handleCancel(res, chat, turnId)
    return true
  }

  const streamMatch = STREAM.exec(path)
  if (streamMatch) {
    if (method !== 'GET') return methodNotAllowed(res, method), true
    const conversationId = decodeSegment(streamMatch[1] ?? '')
    if (conversationId === null) return failJson(res, 'invalid_body', 'invalid conversation id'), true
    handleStream(req, res, url, conversationId, db, chat)
    return true
  }

  const messagesMatch = MESSAGES.exec(path)
  if (messagesMatch) {
    const conversationId = decodeSegment(messagesMatch[1] ?? '')
    if (conversationId === null) return failJson(res, 'invalid_body', 'invalid conversation id'), true
    if (method === 'GET') {
      handleMessagesGet(res, db, conversationId, url)
      return true
    }
    if (method !== 'POST') return methodNotAllowed(res, method), true
    await handleMessagesPost(req, res, chat, conversationId)
    return true
  }

  if (method !== 'GET') return methodNotAllowed(res, method), true
  handleConversations(res, db, deps.now?.())
  return true
}
