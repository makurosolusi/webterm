// First gate of every channel webhook: body size cap and header lookup.
// Runs before any parse or HMAC work; nothing here allocates unbounded state.
import { createHash, timingSafeEqual } from 'node:crypto'


/** Hard cap for a channel webhook body; matches the control API limit (64 KiB). */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024

export const SIGNATURE_HEADER = 'x-webterm-signature'
export const TIMESTAMP_HEADER = 'x-webterm-timestamp'
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token'

export { headerValue } from '../httpHeaders'

export function bodyBytes(rawBody: string | Uint8Array): Buffer {
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
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}
