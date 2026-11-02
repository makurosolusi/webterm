// Telegram inbound surface: env-name/limit constants and the Update normalizer. Outbound sends live
// in `telegramSend.ts` (the only egress path); this file is provider-only and network-free.

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
