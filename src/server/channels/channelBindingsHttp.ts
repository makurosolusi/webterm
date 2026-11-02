// Human binding API edge (P3): exact `/api/channels/telegram/bindings`. Authorization is NOT done
// here — the server calls this only after its root-token gate, so a per-node token can never reach
// it. Transport rules: JSON only, 8 KiB body cap, no body read for GET/DELETE, and no error text
// that could echo a token. A missing store means the channel is disabled: 503, never a 404 guess.
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TELEGRAM_BINDINGS_PATH,
  channelBindingsRoute,
  type BindingAudit,
  type BindingStorePort,
} from './channelBindingsApi'
import { declaredLength, readCappedBody, writeJson } from './channelHttp'

export const BINDINGS_BODY_LIMIT_BYTES = 8 * 1024
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json\b/i

/**
 * True when this handler owns the request (path matched), false otherwise. The body is consumed
 * asynchronously; the response is written by `respond`.
 */
export function handleChannelBindingsApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: BindingStorePort | undefined,
  audit?: BindingAudit,
  pending?: { remove(chatId: string): boolean }
): boolean {
  const url = new URL(req.url || '/', 'http://x')
  if (url.pathname !== TELEGRAM_BINDINGS_PATH) return false
  if (store === undefined) {
    writeJson(res, 503, { ok: false, error: 'channel_disabled' })
    return true
  }
  void respond(req, res, url, store, audit, pending)
  return true
}

type PreparedBody = { ok: true; body: string } | { ok: false; status: 400 | 413; error: string }

async function prepareBody(req: IncomingMessage): Promise<PreparedBody> {
  const declared = declaredLength(req.headers['content-length'])
  if (declared !== undefined && declared > BINDINGS_BODY_LIMIT_BYTES) {
    req.resume()
    return { ok: false, status: 413, error: 'body_too_large' }
  }
  const read = await readCappedBody(req, BINDINGS_BODY_LIMIT_BYTES)
  if (read.ok) return { ok: true, body: read.body }
  return read.reason === 'too_large'
    ? { ok: false, status: 413, error: 'body_too_large' }
    : { ok: false, status: 400, error: 'read_failed' }
}

function isJsonContentType(raw: string | string[] | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value !== undefined && JSON_CONTENT_TYPE.test(value.trim())
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: BindingStorePort,
  audit: BindingAudit | undefined,
  pending: { remove(chatId: string): boolean } | undefined
): Promise<void> {
  const method = (req.method ?? '').toUpperCase()
  let body = ''
  if (method === 'POST') {
    if (!isJsonContentType(req.headers['content-type'])) {
      req.resume()
      writeJson(res, 415, { ok: false, error: 'unsupported_media_type' })
      return
    }
    const prepared = await prepareBody(req)
    if (!prepared.ok) {
      writeJson(res, prepared.status, { ok: false, error: prepared.error })
      return
    }
    body = prepared.body
  } else {
    // GET/DELETE/405 never read the stream; drain it so keep-alive is not left half-consumed.
    req.resume()
  }
  try {
    const result = await channelBindingsRoute(
      url.pathname,
      method,
      url.searchParams,
      async () => body,
      store,
      audit,
      pending
    )
    if (result === null) {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE' })
      return
    }
    writeJson(res, result.status, result.body)
  } catch {
    // The route already maps store failures; this guards a malformed URL edge only.
    writeJson(res, 500, { ok: false, error: 'internal_error' })
  }
}
