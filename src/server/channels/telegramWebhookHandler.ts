// Webhook request handling for the Telegram channel: pure `handleTelegramWebhook` (method, size,
// secret, parse, dispatch) plus the node:http adapter with the failed-secret throttle. Split from
// channelsRuntime.ts so that file stays boot wiring only; it re-exports everything here.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DispatchOutcome } from './channelDispatch'
import { declaredLength, readCappedBody, writeJson, type BodyReadResult } from './channelHttp'
import type { FailureThrottle } from './channelThrottle'
import { MAX_WEBHOOK_BODY_BYTES, verifyTelegramSecret } from './webhook'
import { safeErrorText } from './safeErrorText'
import { webhookPeerKey } from './webhookPeer'
import { createLogger } from '../logs'

const log = createLogger('channels.telegram')

export type WebhookBodyResult = BodyReadResult

export interface ChannelWebhookRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  /** Parsed `content-length`, when the provider sent one. */
  declaredLength?: number
  readBody(): Promise<WebhookBodyResult>
}

export type ChannelWebhookResponseBody = { ok: boolean; error?: string; duplicate?: boolean }
export interface ChannelWebhookResponse {
  status: 200 | 400 | 401 | 405 | 413 | 500
  body: ChannelWebhookResponseBody
}

export interface ChannelWebhookRuntime {
  secret: string
  dispatch(update: unknown): Promise<DispatchOutcome>
}

function fail(status: ChannelWebhookResponse['status'], error: string): ChannelWebhookResponse {
  return { status, body: { ok: false, error } }
}

/**
 * Pure webhook entry point. Order is deliberate: method, then size (declared and actual), then
 * the constant-time `secret_token`, then parse, then the idempotent dispatch. Errors never carry
 * the secret, the body, or a stack.
 */
export async function handleTelegramWebhook(
  request: ChannelWebhookRequest,
  runtime: ChannelWebhookRuntime
): Promise<ChannelWebhookResponse> {
  if ((request.method ?? '').toUpperCase() !== 'POST') {
    return fail(405, 'method_not_allowed')
  }
  if (request.declaredLength !== undefined && request.declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return fail(413, 'body_too_large')
  }
  const verified = verifyTelegramSecret(request.headers, runtime.secret)
  if (!verified.ok) return fail(401, verified.reason)

  const body = await request.readBody()
  // One code for both size paths (declared header and streamed overflow); "too_large" stays internal.
  if (!body.ok) {
    return body.reason === 'too_large' ? fail(413, 'body_too_large') : fail(500, 'read_failed')
  }

  let update: unknown
  try {
    update = JSON.parse(body.body)
  } catch {
    return fail(400, 'invalid_json')
  }
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return fail(400, 'invalid_update')
  }

  try {
    const outcome = await runtime.dispatch(update)
    return { status: 200, body: { ok: true, ...(outcome.status === 'duplicate' ? { duplicate: true } : {}) } }
  } catch (err) {
    // The thrown message can only be logged after scrubbing; the client gets a bare 500.
    log.error('channel.dispatch', `telegram webhook dispatch failed: ${safeError(err)}`)
    return fail(500, 'internal_error')
  }
}

/** Scrubbed, truncated error text that is safe to log. */
export function safeError(err: unknown): string {
  return safeErrorText(err, 'unknown error')
}

export async function respondToWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ChannelWebhookRuntime,
  throttle: FailureThrottle,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const peer = webhookPeerKey(req, env)
  const blockedFor = throttle.retryAfterSeconds(peer)
  if (blockedFor !== null) {
    writeJson(res, 429, { ok: false, error: 'too_many_requests' }, { 'Retry-After': String(blockedFor) })
    return
  }
  let result: ChannelWebhookResponse
  try {
    result = await handleTelegramWebhook(
      {
        method: req.method,
        headers: req.headers,
        declaredLength: declaredLength(req.headers['content-length']),
        readBody: () => readCappedBody(req, MAX_WEBHOOK_BODY_BYTES),
      },
      runtime
    )
  } catch {
    result = fail(500, 'internal_error')
  }
  if (result.status === 401) throttle.recordFailure(peer)
  writeJson(res, result.status, result.body)
}
