// Low-level Telegram egress transport. `telegramSender.ts` re-exports this so callers have one
// import surface. The bot token comes ONLY from env `TELEGRAM_BOT_TOKEN`, read on every send so
// rotation needs no restart. It is never stored, returned, or logged; every error is scrubbed.
import { DEFAULT_TELEGRAM_API_BASE, TELEGRAM_MAX_TEXT } from './telegram'
import { redactSecrets } from './webhook'

export const TELEGRAM_BOT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN'
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000

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

function clean(text: string, token: string): string {
  return redactSecrets(text, [token]).slice(0, 300)
}

function failure(
  status: number,
  error: string,
  reason: TelegramSendFailureReason,
  retryable: boolean,
  retryAfterMs?: number
): TelegramSendResult {
  return {
    ok: false,
    status,
    error,
    reason,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
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
  const token = (options.env?.() ?? process.env)[TELEGRAM_BOT_TOKEN_ENV]?.trim()
  if (!token) return failure(0, 'bot_token_not_configured', 'not_configured', false)
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
      : failure(0, clean(errorText(err), token), 'network', true)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (!response || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) {
    const status = response?.status ?? 0
    return failure(
      status,
      clean(`http_${status}`, token),
      'rejected',
      status === 429 || status >= 500
    )
  }

  let payload: Record<string, unknown>
  try {
    payload = asRecord(await response.json())
  } catch {
    return failure(response.status, 'invalid_response', 'invalid_response', true)
  }

  if (payload['ok'] !== true) {
    const description = typeof payload['description'] === 'string' ? payload['description'] : ''
    const params = asRecord(payload['parameters'])
    const retryAfter = optionalInt(params['retry_after'])
    return failure(
      response.status,
      clean(description || 'provider_rejected', token),
      'rejected',
      retryAfter !== undefined || response.status === 429,
      retryAfter !== undefined && retryAfter >= 0 ? retryAfter * 1000 : undefined
    )
  }

  const result = asRecord(payload['result'])
  return { ok: true, status: response.status, messageId: optionalInt(result['message_id']) ?? null }
}
