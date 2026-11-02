// HMAC signature verification for `x-webterm-signature` / `x-webterm-timestamp`.
import { createHmac } from 'node:crypto'

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  bodyBytes,
  bodyWithinLimit,
  headerValue,
  safeEqual,
} from './webhookGate'
import type { WebhookHeaders, WebhookVerification } from './webhookTypes'

/** Accepted clock skew / replay window for `x-webterm-timestamp` (unix seconds). */
export const REPLAY_WINDOW_SECONDS = 5 * 60

/** HMAC-SHA256 over `${timestamp}.${rawBody}`; the header value is `sha256=<hex>`. */
export function signWebhook(secret: string, rawBody: string | Uint8Array, timestamp: number): string {
  const mac = createHmac('sha256', secret)
  mac.update(`${timestamp}.`)
  mac.update(bodyBytes(rawBody))
  return `sha256=${mac.digest('hex')}`
}

export interface VerifyWebhookInput {
  secret: string | undefined
  rawBody: string | Uint8Array
  headers: WebhookHeaders | undefined
  nowSeconds?: number
  windowSeconds?: number
}

/**
 * Full generic-ingress check. Order matters: size cap (413) before auth (401), so an oversized
 * body is rejected without hashing, and a stale timestamp is rejected before any state work.
 */
export function verifyWebhook(input: VerifyWebhookInput): WebhookVerification {
  if (!bodyWithinLimit(input.rawBody)) {
    return { ok: false, status: 413, reason: 'body_too_large' }
  }
  if (!input.secret) return { ok: false, status: 401, reason: 'secret_not_configured' }

  const rawTimestamp = headerValue(input.headers, TIMESTAMP_HEADER)
  if (!rawTimestamp) return { ok: false, status: 401, reason: 'missing_timestamp' }
  if (!/^\d{1,12}$/.test(rawTimestamp)) {
    return { ok: false, status: 401, reason: 'invalid_timestamp' }
  }
  const timestamp = Number(rawTimestamp)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const window = input.windowSeconds ?? REPLAY_WINDOW_SECONDS
  if (Math.abs(now - timestamp) > window) {
    return { ok: false, status: 401, reason: 'stale_timestamp' }
  }

  const provided = headerValue(input.headers, SIGNATURE_HEADER)
  if (!provided) return { ok: false, status: 401, reason: 'missing_signature' }
  const expected = signWebhook(input.secret, input.rawBody, timestamp)
  if (!safeEqual(expected, provided.toLowerCase())) {
    return { ok: false, status: 401, reason: 'bad_signature' }
  }
  return { ok: true, timestamp }
}
