// Telegram `secret_token` ingress check (RND/qc/p3-security.md M3).
import { TELEGRAM_SECRET_HEADER, headerValue, safeEqual } from './webhookGate'
import type { AttemptThrottle } from './webhookThrottle'
import type { WebhookHeaders, WebhookVerification } from './webhookTypes'

/**
 * Minimum accepted `secret_token` length (Telegram recommends 1-256 chars, which permits a
 * guessable secret). 32 chars of `[A-Za-z0-9_-]` is ~190 bits, so online guessing is infeasible
 * (RND/qc/p3-security.md M3). A shorter configured secret fails closed.
 */
export const MIN_TELEGRAM_SECRET_LENGTH = 32
export const MAX_TELEGRAM_SECRET_LENGTH = 256
const TELEGRAM_SECRET_SHAPE = /^[A-Za-z0-9_-]+$/

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
