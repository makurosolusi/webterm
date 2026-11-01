// Single egress scrubber for error strings and log lines. Other channel modules reuse this
// instead of building their own patterns.

/** Env names whose values must never appear in a log line, error string, or serialized result. */
export const SECRET_ENV_NAMES = [
  'WEBTERM_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'WEBTERM_TELEGRAM_WEBHOOK_SECRET',
  'WEBTERM_CHANNEL_HMAC_SECRET',
  'WEBTERM_TOKEN',
] as const

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
