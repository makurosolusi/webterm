// Single egress scrubber for the whole server: error strings, log lines, memory-file text,
// persisted conversation payloads and streamed runtime events all go through these patterns.
// Add a credential shape here once; never grow a second pattern list elsewhere.

export const REDACTED = '[redacted]'

/** Env names whose values must never appear in a log line, error string, or serialized result. */
export const SECRET_ENV_NAMES = [
  'WEBTERM_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'WEBTERM_TELEGRAM_WEBHOOK_SECRET',
  'WEBTERM_TOKEN',
] as const

const MIN_SECRET_LENGTH = 6
const NAME_PREFIX = '[A-Za-z0-9_.-]*'

/** Free-text credential shapes -> replacement. Order matters only for Bearer before JWT. */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bbot\d+:[A-Za-z0-9_-]{10,}\b/g, `bot${REDACTED}`],
  // Bare BotFather token (`<bot id>:<35 chars>`), as pasted by a human or echoed by a model without the `bot` prefix.
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}/g, REDACTED],
  [/\bwcap_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // NAME=value / NAME: value for credential-named keys (GITHUB_TOKEN=..., "api_key": "...").
  [
    new RegExp(
      `\\b(${NAME_PREFIX}(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)["']?)(\\s*[:=]\\s*)["']?[^\\s"',;}]{6,}["']?`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
]

/** Object keys whose value is always masked, whatever it contains. */
const SECRET_KEY =
  /^(password|passwd|secret|token|bot[-_]?token|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|authorization|cookie|private[-_]?key|credentials?)$/i

/**
 * Egress scrubber for text. `secrets` is for in-memory values a caller already holds (never pass
 * them onward); env values are read at call time so rotation is picked up. Non-strings pass through.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined | null> = []): string {
  if (typeof text !== 'string' || !text) return text
  let out = text
  const exact = [...secrets, ...SECRET_ENV_NAMES.map((name) => process.env[name])]
  for (const secret of exact) {
    if (secret && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED)
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Bounds for `redactValue`: streaming events are capped hard, persisted payloads are not. */
export interface RedactLimits { maxDepth: number; maxItems: number }
export const STREAM_LIMITS: RedactLimits = { maxDepth: 6, maxItems: 50 }
export const PERSIST_LIMITS: RedactLimits = { maxDepth: 21, maxItems: Infinity }

/** Deep-redact a JSON-ish value (secret-named keys masked, strings scrubbed) without mutating it. */
export function redactValue(value: unknown, limits: RedactLimits = STREAM_LIMITS, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  if (depth >= limits.maxDepth) return REDACTED
  if (Array.isArray(value)) return value.slice(0, limits.maxItems).map((item) => redactValue(item, limits, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, limits.maxItems)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, limits, depth + 1)
  }
  return out
}
