// Low-level Telegram egress transport. `telegramSender.ts` re-exports this so callers have one
// import surface. The bot token comes ONLY from env (`WEBTERM_TELEGRAM_BOT_TOKEN`, falling back to
// legacy `TELEGRAM_BOT_TOKEN`), read on every send so rotation needs no restart. It is never
// stored, returned, or logged; every error is scrubbed.
import {
  DEFAULT_TELEGRAM_API_BASE,
  TELEGRAM_MAX_TEXT,
  TELEGRAM_TOKEN_ENV,
  TELEGRAM_TOKEN_ENV_LEGACY,
} from './telegram'
import { redactSecrets } from './webhook'

/** Env names tried in precedence order: preferred first, then the legacy alias. */
export const TELEGRAM_BOT_TOKEN_ENV_NAMES = [TELEGRAM_TOKEN_ENV, TELEGRAM_TOKEN_ENV_LEGACY] as const
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000

/**
 * Single bot-token lookup for egress. Precedence: `WEBTERM_TELEGRAM_BOT_TOKEN`, then legacy
 * `TELEGRAM_BOT_TOKEN`. Values are trimmed and whitespace-only counts as unset, so a blank
 * preferred name falls back instead of disabling egress. Returns `undefined` when unconfigured.
 * Call this per send (never at module load) so rotation needs no restart.
 */
export function resolveTelegramBotToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of TELEGRAM_BOT_TOKEN_ENV_NAMES) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export interface TelegramSenderResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type TelegramSenderFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<TelegramSenderResponse>

export interface TelegramSendInput {
  chatId: string
  text: string
  threadId?: number
}

export interface TelegramSendOptions {
  fetch?: TelegramSenderFetch
  /** Test seam only: production reads process.env at send time. */
  env?: () => NodeJS.ProcessEnv
  /** Explicit token for programmatic callers; wins over the env lookup when non-blank. */
  token?: string
  apiBase?: string
  timeoutMs?: number
}

export type TelegramSendFailureReason =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'rejected'
  | 'invalid_response'

export type TelegramSendResult =
  | { ok: true; status: number; messageId: number | null }
  | {
      ok: false
      status: number
      error: string
      reason: TelegramSendFailureReason
      retryable: boolean
      retryAfterMs?: number
      /** Bot API `error_code` when the provider returned one (already numeric, no secrets). */
      errorCode?: number
    }

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : 'telegram_send_failed'
}

function clean(text: string, secrets: Array<string | undefined>): string {
  return redactSecrets(text, secrets).slice(0, 300)
}

function failure(
  status: number,
  error: string,
  reason: TelegramSendFailureReason,
  retryable: boolean,
  retryAfterMs?: number,
  errorCode?: number
): TelegramSendResult {
  return {
    ok: false,
    status,
    error,
    reason,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

function resolveApiBase(options: TelegramSendOptions): string {
  const configured = options.apiBase ?? process.env['WEBTERM_TELEGRAM_API_BASE']
  return (configured ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '')
}

/**
 * Send one plain-text message. Never throws. `parse_mode` is deliberately absent so untrusted
 * text is delivered literally (no Markdown/HTML injection).
 */
export async function sendTelegramMessage(
  input: TelegramSendInput,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const env = options.env?.() ?? process.env
  const token = options.token?.trim() || resolveTelegramBotToken(env)
  if (!token) return failure(0, 'bot_token_not_configured', 'not_configured', false)
  // Scrub every configured name, not just the winner: a misconfigured deployment may echo either.
  const secrets = [token, env[TELEGRAM_TOKEN_ENV], env[TELEGRAM_TOKEN_ENV_LEGACY]]
  if (!input.chatId.trim() || !input.text.trim()) {
    return failure(0, 'chat_id_and_text_required', 'rejected', false)
  }

  const doFetch = options.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch)
  if (typeof doFetch !== 'function') return failure(0, 'fetch_not_available', 'network', true)

  const timeoutMs = Math.max(1, options.timeoutMs ?? TELEGRAM_SEND_TIMEOUT_MS)
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text.slice(0, TELEGRAM_MAX_TEXT),
  }
  if (input.threadId !== undefined) body['message_thread_id'] = input.threadId

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller?.abort()
      reject(new Error('telegram_send_timeout'))
    }, timeoutMs)
  })

  let response: TelegramSenderResponse
  try {
    response = await Promise.race([
      doFetch(`${resolveApiBase(options)}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(controller === undefined ? {} : { signal: controller.signal }),
      }),
      timeout,
    ])
  } catch (err) {
    // The thrown message may embed the request URL, which contains the token; scrub it.
    return timedOut
      ? failure(0, 'timeout', 'timeout', true)
      : failure(0, clean(errorText(err), secrets), 'network', true)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (!response || typeof response.status !== 'number') {
    return failure(0, 'invalid_response', 'invalid_response', true)
  }
  const httpOk = response.status >= 200 && response.status < 300

  let payload: Record<string, unknown>
  try {
    payload = asRecord(await response.json())
  } catch (err) {
    // A non-2xx body is often not JSON (proxy/HTML); the status alone is still a usable signal.
    if (!httpOk) {
      const retryable = response.status === 429 || response.status >= 500
      return failure(response.status, `http_${response.status}`, 'rejected', retryable)
    }
    return failure(response.status, clean(`invalid_response: ${errorText(err)}`, secrets), 'invalid_response', true)
  }

  if (!httpOk || payload['ok'] !== true) {
    // Bot API failures carry `description` (e.g. "chat not found"), `error_code` and
    // `parameters.retry_after`; surface them so operators can tell a bad token from a bad chat.
    const description = typeof payload['description'] === 'string' ? payload['description'] : ''
    const params = asRecord(payload['parameters'])
    const retryAfter = optionalInt(params['retry_after'])
    const errorCode = optionalInt(payload['error_code'])
    const label = httpOk ? '' : `http_${response.status}`
    const text = [label, description].filter(Boolean).join(': ') || 'provider_rejected'
    return failure(
      response.status,
      clean(text, secrets),
      'rejected',
      retryAfter !== undefined || response.status === 429 || (!httpOk && response.status >= 500),
      retryAfter !== undefined && retryAfter >= 0 ? retryAfter * 1000 : undefined,
      errorCode
    )
  }

  const result = asRecord(payload['result'])
  return { ok: true, status: response.status, messageId: optionalInt(result['message_id']) ?? null }
}
