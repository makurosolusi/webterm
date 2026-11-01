// Generic channel ingress verification (O12/P3). Every channel webhook passes the same gate:
// body size cap FIRST, then signature/timestamp (replay window), then provider-specific auth.
// Nothing here writes state or calls the network, so the gate is testable without a server.
//
// Secrets are read from env at CALL time, never captured at module load, and never included in
// a returned value or an error string. `redactSecrets` is the single egress scrubber; other
// channel modules reuse it instead of building their own patterns.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Hard cap for a channel webhook body; matches the control API limit (64 KiB). */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024

export const SIGNATURE_HEADER = 'x-webterm-signature'
export const TIMESTAMP_HEADER = 'x-webterm-timestamp'
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token'

/**
 * Minimum accepted `secret_token` length (Telegram recommends 1-256 chars, which permits a
 * guessable secret). 32 chars of `[A-Za-z0-9_-]` is ~190 bits, so online guessing is infeasible
 * (RND/qc/p3-security.md M3). A shorter configured secret fails closed.
 */
export const MIN_TELEGRAM_SECRET_LENGTH = 32
export const MAX_TELEGRAM_SECRET_LENGTH = 256
const TELEGRAM_SECRET_SHAPE = /^[A-Za-z0-9_-]+$/

/** Default auth-failure budget per key inside the window. */
export const DEFAULT_AUTH_FAILURE_LIMIT = 30
export const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000
/** Bound on tracked keys so a distributed attacker cannot grow the map without limit. */
const MAX_THROTTLE_KEYS = 4096

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

/**
 * Constant-time equality. Both sides are hashed first, so the comparison time never depends on
 * the length or the prefix of either value (a plain `timingSafeEqual` needs equal lengths and
 * therefore leaks "wrong length" immediately).
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/** Sliding-window failure counter: N failures per key in the window, then the key is blocked. */
export class AttemptThrottle {
  private readonly limit: number
  private readonly windowMs: number
  private readonly clock: () => number
  private readonly buckets = new Map<string, { failures: number; resetAt: number }>()

  constructor(
    options: { limit?: number; windowMs?: number; now?: () => number } = {}
  ) {
    const limit = options.limit ?? DEFAULT_AUTH_FAILURE_LIMIT
    const windowMs = options.windowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('throttle limit must be positive')
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('throttle window must be positive')
    this.limit = limit
    this.windowMs = windowMs
    this.clock = options.now ?? Date.now
  }

  /** True when `key` may still attempt. Does not consume budget. */
  allow(key: string): boolean {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return true
    if (this.clock() >= bucket.resetAt) {
      this.buckets.delete(key)
      return true
    }
    return bucket.failures < this.limit
  }

  /** Records one failed attempt; returns the remaining budget (0 means now blocked). */
  fail(key: string): number {
    const now = this.clock()
    const bucket = this.buckets.get(key)
    if (bucket === undefined || now >= bucket.resetAt) {
      this.evict(now)
      this.buckets.set(key, { failures: 1, resetAt: now + this.windowMs })
      return Math.max(0, this.limit - 1)
    }
    bucket.failures += 1
    return Math.max(0, this.limit - bucket.failures)
  }

  /** Clears the budget after a proven-good credential. */
  succeed(key: string): void {
    this.buckets.delete(key)
  }

  size(): number {
    return this.buckets.size
  }

  private evict(now: number): void {
    if (this.buckets.size < MAX_THROTTLE_KEYS) return
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
    // Still full: drop the oldest insertion (a guess flood cannot pin memory forever).
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_THROTTLE_KEYS) break
      this.buckets.delete(key)
    }
  }
}

/**
 * Boot-time check for a configured `secret_token`: shape and minimum length. Returns the problem
 * (safe to log) or null. The webhook also enforces this per request, so a short secret is still
 * refused even if the wiring check is bypassed.
 */
export function telegramSecretProblem(secret: string | undefined): string | null {
  if (secret === undefined || secret.trim() === '') return 'telegram webhook secret is not set'
  if (secret.length < MIN_TELEGRAM_SECRET_LENGTH) {
    return `telegram webhook secret must be at least ${MIN_TELEGRAM_SECRET_LENGTH} characters`
  }
  if (secret.length > MAX_TELEGRAM_SECRET_LENGTH) {
    return `telegram webhook secret must be at most ${MAX_TELEGRAM_SECRET_LENGTH} characters`
  }
  if (!TELEGRAM_SECRET_SHAPE.test(secret)) return 'telegram webhook secret has an invalid shape'
  return null
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

export interface TelegramSecretOptions {
  /**
   * Failure throttle for the caller's key. Optional on purpose: the HTTP edge
   * (`channelsRuntime.respondToWebhook`) already throttles per peer address with 429, so this
   * hook is for callers that verify a secret outside that edge (tests, other channels).
   */
  clientKey?: string
  throttle?: AttemptThrottle
}

/**
 * Telegram `secret_token` check. Fails closed when the deployment has no secret configured, when
 * the configured secret is shorter than `MIN_TELEGRAM_SECRET_LENGTH`, and once the caller's
 * failure budget is exhausted (guessing / `update_id` poisoning, RND/qc/p3-security.md M3).
 *
 * The comparison is constant-time over digests, so neither value's length leaks.
 */
export function verifyTelegramSecret(
  headers: WebhookHeaders | undefined,
  expected: string | undefined,
  options: TelegramSecretOptions = {}
): WebhookVerification {
  if (!expected) return { ok: false, status: 401, reason: 'secret_not_configured' }
  if (telegramSecretProblem(expected) !== null) {
    // Misconfigured deployments must not accept traffic at all.
    return { ok: false, status: 401, reason: 'secret_too_weak' }
  }
  const throttle = options.throttle
  const key = options.clientKey ?? 'global'
  if (throttle !== undefined && !throttle.allow(key)) {
    return { ok: false, status: 401, reason: 'too_many_attempts' }
  }
  const provided = headerValue(headers, TELEGRAM_SECRET_HEADER)
  if (!provided) {
    throttle?.fail(key)
    return { ok: false, status: 401, reason: 'missing_secret_token' }
  }
  if (!safeEqual(expected, provided)) {
    throttle?.fail(key)
    return { ok: false, status: 401, reason: 'bad_secret_token' }
  }
  throttle?.succeed(key)
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
