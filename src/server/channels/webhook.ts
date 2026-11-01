// Generic channel ingress verification (O12/P3). Every channel webhook passes the same gate:
// body size cap FIRST, then signature/timestamp (replay window), then provider-specific auth.
// Nothing here writes state or calls the network, so the gate is testable without a server.
//
// Secrets are read from env at CALL time, never captured at module load, and never included in
// a returned value or an error string. `redactSecrets` is the single egress scrubber; other
// channel modules reuse it instead of building their own patterns.
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Hard cap for a channel webhook body; matches the control API limit (64 KiB). */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024

export const SIGNATURE_HEADER = 'x-webterm-signature'
export const TIMESTAMP_HEADER = 'x-webterm-timestamp'
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token'

/** Accepted clock skew / replay window for `x-webterm-timestamp` (unix seconds). */
export const REPLAY_WINDOW_SECONDS = 5 * 60

/** Env names whose values must never appear in a log line, error string, or serialized result. */
export const SECRET_ENV_NAMES = [
  'WEBTERM_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'WEBTERM_TELEGRAM_WEBHOOK_SECRET',
  'WEBTERM_CHANNEL_HMAC_SECRET',
  'WEBTERM_TOKEN',
] as const

export type WebhookHeaders = Record<string, string | string[] | undefined>
export type WebhookRejectStatus = 401 | 413

export type WebhookVerification =
  | { ok: true; timestamp: number }
  | { ok: false; status: WebhookRejectStatus; reason: string }

/** Header lookup is case-insensitive; duplicated (array) headers are rejected, not guessed. */
export function headerValue(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const want = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== want) continue
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

function bodyBytes(rawBody: string | Uint8Array): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody)
}

/** True when the raw body fits the cap. Checked before any parse or HMAC work. */
export function bodyWithinLimit(rawBody: string | Uint8Array): boolean {
  return bodyBytes(rawBody).byteLength <= MAX_WEBHOOK_BODY_BYTES
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // Different lengths already mean "not equal"; the digest comparison below is constant-time.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

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

/** Telegram `secret_token` check. Fails closed when the deployment has no secret configured. */
export function verifyTelegramSecret(
  headers: WebhookHeaders | undefined,
  expected: string | undefined
): WebhookVerification {
  if (!expected) return { ok: false, status: 401, reason: 'secret_not_configured' }
  const provided = headerValue(headers, TELEGRAM_SECRET_HEADER)
  if (!provided) return { ok: false, status: 401, reason: 'missing_secret_token' }
  if (!safeEqual(expected, provided)) {
    return { ok: false, status: 401, reason: 'bad_secret_token' }
  }
  return { ok: true, timestamp: Math.floor(Date.now() / 1000) }
}

export interface WebhookHttpResponse {
  status: number
  body: { ok: boolean; error?: string }
}

/**
 * HTTP shape for a webhook result. 200 means "durably accepted, no reply"; 202 means
 * "accepted, reply follows". Auth/size failures map to their status with no detail leak.
 */
export function webhookResponse(
  verification: WebhookVerification,
  acceptedStatus: 200 | 202 = 200
): WebhookHttpResponse {
  if (verification.ok) return { status: acceptedStatus, body: { ok: true } }
  return { status: verification.status, body: { ok: false, error: verification.reason } }
}

const LONG_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bbot\d+:[A-Za-z0-9_-]{10,}\b/g, 'bot[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\bwcap_[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
]

/**
 * Egress scrubber for error strings and log lines. `secrets` is for the in-memory values a caller
 * already holds (never pass them onward); env values are read at call time so rotation is picked up.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined | null> = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]')
  }
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name]
    if (value && value.length >= 6) out = out.split(value).join('[redacted]')
  }
  for (const [pattern, replacement] of LONG_SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}
