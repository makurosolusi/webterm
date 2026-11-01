// Telegram adapter surface (O18-O21), provider-only and network-free at import time.
// Inbound updates are normalized into the channel-agnostic message shape; outbound sends take an
// injected fetch so tests never touch the network. The bot token is resolved from env at CALL time
// and never appears in the returned value, an error string, or a log line.
import { redactSecrets } from './webhook'

export const TELEGRAM_TOKEN_ENV = 'WEBTERM_TELEGRAM_BOT_TOKEN'
export const TELEGRAM_TOKEN_ENV_LEGACY = 'TELEGRAM_BOT_TOKEN'
/** Bot API message limit; longer text is truncated rather than rejected by the provider. */
export const TELEGRAM_MAX_TEXT = 4096
export const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org'

export interface NormalizedMessage {
  updateId: number
  chatId: string
  userId: string
  text: string
  isGroup: boolean
  messageId?: number
  threadId?: number
}

type Json = Record<string, unknown>

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

/** Provider ids are numeric in Telegram but stay strings so signs and 64-bit ids survive. */
function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value
  return undefined
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * Normalize a Telegram `Update` into `NormalizedMessage`, or `null` when it is not a
 * user message we can act on (no update id, no chat/from, callback-only update).
 * `isGroup` covers `group`/`supergroup`; private chats are never groups.
 */
export function parseTelegramUpdate(update: unknown): NormalizedMessage | null {
  const root = asRecord(update)
  const updateId = optionalInt(root['update_id'])
  if (updateId === undefined || updateId < 0) return null

  const message = asRecord(root['message'])
  const chat = asRecord(message['chat'])
  const from = asRecord(message['from'])
  const chatId = idString(chat['id'])
  const userId = idString(from['id'])
  if (!chatId || !userId) return null

  const chatType = typeof chat['type'] === 'string' ? chat['type'] : ''
  const text = typeof message['text'] === 'string' ? message['text'] : ''
  return {
    updateId,
    chatId,
    userId,
    text,
    isGroup: chatType === 'group' || chatType === 'supergroup',
    messageId: optionalInt(message['message_id']),
    threadId: optionalInt(message['message_thread_id']),
  }
}

/** Minimal fetch contract: enough for one Bot API call, easy to fake in tests. */
export interface TelegramFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type TelegramFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<TelegramFetchResponse>

export interface TelegramSendInput {
  chatId: string
  text: string
  threadId?: number
  replyToMessageId?: number
  disableNotification?: boolean
}

export interface TelegramSendOptions {
  /** Explicit token wins over env; both are read per call so rotation needs no restart. */
  token?: string
  fetch?: TelegramFetch
  apiBase?: string
}

export type TelegramSendResult =
  | { ok: true; messageId: number | null }
  | { ok: false; status: number; error: string; retryAfterMs?: number }

/** Token lookup at call time. Returns `undefined` when the deployment is not configured. */
export function telegramBotToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env[TELEGRAM_TOKEN_ENV] ?? env[TELEGRAM_TOKEN_ENV_LEGACY]
  return token && token.trim() ? token.trim() : undefined
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'telegram_send_failed'
}

function resolveApiBase(options: TelegramSendOptions): string {
  const configured = options.apiBase ?? process.env['WEBTERM_TELEGRAM_API_BASE']
  return (configured ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '')
}

/**
 * Send one plain-text message. Never throws: the outbox owns retry/backoff, and a channel outage
 * must not propagate into the ledger transaction that enqueued the notification.
 * No `parse_mode` is set, so untrusted text is delivered literally (no Markdown/HTML injection).
 */
export async function sendTelegramMessage(
  input: TelegramSendInput,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  const token = options.token ?? telegramBotToken()
  if (!token) {
    return { ok: false, status: 0, error: 'bot_token_not_configured' }
  }
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as TelegramFetch)
  if (typeof doFetch !== 'function') {
    return { ok: false, status: 0, error: 'fetch_not_available' }
  }

  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text.slice(0, TELEGRAM_MAX_TEXT),
  }
  if (input.threadId !== undefined) body['message_thread_id'] = input.threadId
  if (input.disableNotification) body['disable_notification'] = true
  if (input.replyToMessageId !== undefined) {
    body['reply_parameters'] = { message_id: input.replyToMessageId, allow_sending_without_reply: true }
  }

  let response: TelegramFetchResponse
  try {
    response = await doFetch(`${resolveApiBase(options)}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    // The thrown message may embed the request URL (which contains the token); scrub it.
    return { ok: false, status: 0, error: redactSecrets(errorText(err), [token]).slice(0, 300) }
  }

  let payload: Json = {}
  try {
    payload = asRecord(await response.json())
  } catch {
    payload = {}
  }

  if (!response.ok || payload['ok'] !== true) {
    const description = typeof payload['description'] === 'string' ? payload['description'] : ''
    const params = asRecord(payload['parameters'])
    const retryAfter = optionalInt(params['retry_after'])
    return {
      ok: false,
      status: response.status,
      error: redactSecrets(description || `http_${response.status}`, [token]).slice(0, 300),
      ...(retryAfter !== undefined && retryAfter >= 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    }
  }

  const result = asRecord(payload['result'])
  const messageId = optionalInt(result['message_id'])
  return { ok: true, messageId: messageId ?? null }
}
