// One Bot API call for the polling loop, with every failure classified and scrubbed. The request
// URL carries the bot token, so no raw thrown message or response text may leave this module.
import { DEFAULT_TELEGRAM_API_BASE } from './telegram'
import type { TelegramSenderFetch } from './telegramSend'
import { redactSecrets } from '../redactSecrets'

/** HTTP statuses that mean the token itself is wrong: polling stops instead of retrying. */
export const TELEGRAM_FATAL_STATUSES: readonly number[] = [401, 404]
const MAX_ERROR_CHARS = 200

export type PollErrorKind = 'fatal' | 'conflict' | 'rate_limited' | 'transient'

/** Failure of one Bot API call; `message` is already redacted and safe to log. */
export class PollApiError extends Error {
  constructor(
    readonly kind: PollErrorKind,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'PollApiError'
  }
}

export interface BotApiCall {
  method: string
  params: Record<string, unknown>
  token: string
  apiBase?: string
  fetch: TelegramSenderFetch
  /** Aborts the request on shutdown. */
  signal: AbortSignal
  timeoutMs: number
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : 'unknown error'
}

function kindFor(status: number): PollErrorKind {
  if (TELEGRAM_FATAL_STATUSES.includes(status)) return 'fatal'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  return 'transient'
}

/** POST one Bot API method and return `result`; throws `PollApiError` with a redacted message. */
export async function callBotApi(call: BotApiCall): Promise<unknown> {
  const { method, token, signal } = call
  const scrub = (text: string): string => redactSecrets(text, [token]).slice(0, MAX_ERROR_CHARS)
  const base = (call.apiBase ?? process.env['WEBTERM_TELEGRAM_API_BASE'] ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '')

  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), call.timeoutMs)
  try {
    let response
    try {
      response = await call.fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call.params),
        signal: ctl.signal,
      })
    } catch (err) {
      const cause = ctl.signal.aborted && !signal.aborted ? 'request timed out' : describe(err)
      throw new PollApiError('transient', scrub(`telegram ${method} network error: ${cause}`))
    }
    let payload: Record<string, unknown> = {}
    try {
      payload = record(await response.json())
    } catch {
      // Non-JSON body (proxy error page): fall through to the status-based classification below.
    }
    if (!response.ok || payload['ok'] !== true) {
      const description = typeof payload['description'] === 'string' ? payload['description'] : ''
      const retryAfter = record(payload['parameters'])['retry_after']
      throw new PollApiError(
        kindFor(response.status),
        scrub(`telegram ${method} failed: http ${response.status}${description ? ` ${description}` : ''}`),
        typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter * 1000 : undefined
      )
    }
    return payload['result']
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
