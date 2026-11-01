// Webhook secret resolution for the Telegram channel edge. Kept apart from the HTTP runtime so the
// "where does the secret come from, and is it good enough" rules are testable without a server.
//
// Two sources, env first, file second. The file must be mode 0600 (group/other bits are refused:
// a readable secret file is not a secret) and the value must be at least 32 characters — a short
// `secret_token` is guessable online (QC M3: a 1-character secret was accepted).
import { readFileSync, statSync } from 'node:fs'

export const TELEGRAM_WEBHOOK_SECRET_ENV = 'WEBTERM_TELEGRAM_WEBHOOK_SECRET'
/** Points at a 0600 file holding the same value, for deployments that mount secrets. */
export const TELEGRAM_WEBHOOK_SECRET_FILE_ENV = 'WEBTERM_TELEGRAM_WEBHOOK_SECRET_FILE'

/** Telegram compares this value on every inbound request; 32 characters is the floor. */
export const MIN_WEBHOOK_SECRET_CHARS = 32
export const MAX_WEBHOOK_SECRET_CHARS = 256
const MAX_SECRET_FILE_BYTES = 4096

const SECRET_SHAPE = new RegExp(
  `^[A-Za-z0-9_-]{${MIN_WEBHOOK_SECRET_CHARS},${MAX_WEBHOOK_SECRET_CHARS}}$`
)

export type SecretFileRead = { ok: true; text: string } | { ok: false; reason: string }

export type SecretResolution =
  | { ok: true; secret: string; source: 'env' | 'file' }
  | { ok: false; reason: string }

/**
 * Read a `0600` regular file. Reasons are static strings so no file content can reach a log line.
 */
export function readSecretFile(path: string): SecretFileRead {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ok: false, reason: 'secret file is not readable' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'secret file is not a regular file' }
  if ((stat.mode & 0o077) !== 0) return { ok: false, reason: 'secret file must be mode 0600' }
  if (stat.size > MAX_SECRET_FILE_BYTES) return { ok: false, reason: 'secret file is too large' }
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch {
    return { ok: false, reason: 'secret file is not readable' }
  }
}

/**
 * Resolve the webhook secret without ever echoing it. `env` wins when both sources are set; the
 * caller reads the file only after the feature flag check, so an off channel reads no secret.
 */
export function resolveWebhookSecret(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => SecretFileRead = readSecretFile
): SecretResolution {
  const shapeHint = `${MIN_WEBHOOK_SECRET_CHARS}-${MAX_WEBHOOK_SECRET_CHARS} [A-Za-z0-9_-]`

  const fromEnv = (env[TELEGRAM_WEBHOOK_SECRET_ENV] ?? '').trim()
  if (fromEnv) {
    return SECRET_SHAPE.test(fromEnv)
      ? { ok: true, secret: fromEnv, source: 'env' }
      : { ok: false, reason: `${TELEGRAM_WEBHOOK_SECRET_ENV} must be ${shapeHint}` }
  }

  const filePath = (env[TELEGRAM_WEBHOOK_SECRET_FILE_ENV] ?? '').trim()
  if (!filePath) {
    return {
      ok: false,
      reason: `neither ${TELEGRAM_WEBHOOK_SECRET_ENV} nor ${TELEGRAM_WEBHOOK_SECRET_FILE_ENV} is set`,
    }
  }

  const read = readFile(filePath)
  if (!read.ok) return { ok: false, reason: read.reason }
  const secret = read.text.trim()
  return SECRET_SHAPE.test(secret)
    ? { ok: true, secret, source: 'file' }
    : { ok: false, reason: `${TELEGRAM_WEBHOOK_SECRET_FILE_ENV} must hold ${shapeHint}` }
}
