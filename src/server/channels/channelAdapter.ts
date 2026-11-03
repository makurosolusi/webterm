// Telegram implementation of the cross-WS `ChannelAdapter` contract (RND/26 §3.3). It only adapts:
// verification, normalization, rendering and the Bot API call. Authorization, dedupe and the outbox
// stay in the dispatcher. Tokens come from `tokenFor` at send time and never enter payloads,
// events or error text (`callBotApi` redacts the URL it builds).
import type {
  AccountId,
  ChannelAdapter,
  ChannelCaps,
  InboundEvent,
  InboundRequest,
  OutboundMessage,
  ProviderPayload,
  SendResult,
} from '../central/contracts'
import { CALLBACK_DATA_MAX_BYTES } from './channelCallback'
import { DEFAULT_ACCOUNT_ID } from './channelStoreMigrate'
import { TELEGRAM_MAX_TEXT, parseTelegramCallback, parseTelegramUpdate } from './telegram'
import { PollApiError, callBotApi } from './telegramPollApi'
import type { TelegramSenderFetch } from './telegramSend'
import { verifyTelegramSecret } from './webhook'

export const TELEGRAM_CAPS: ChannelCaps = {
  maxText: TELEGRAM_MAX_TEXT,
  edit: true,
  buttons: true,
  threads: true,
  stream: false,
  groupMirror: false,
}
const BOT_API_TIMEOUT_MS = 10_000

export interface TelegramAdapterOptions {
  /** Account this adapter instance receives for (one webhook secret per bot). */
  accountId?: AccountId
  secret: string
  /** Secret-store lookup at send time; undefined = account has no token. */
  tokenFor(accountId: AccountId): string | undefined
  fetch?: TelegramSenderFetch
  apiBase?: string
}

export interface TelegramAdapter extends ChannelAdapter {
  /** Dismisses the client spinner after a button press. */
  answerCallback(accountId: AccountId, callbackId: string, text: string): Promise<SendResult>
}

/** Build the Telegram adapter; every provider failure becomes a `SendResult`, never a throw. */
export function createTelegramAdapter(options: TelegramAdapterOptions): TelegramAdapter {
  const account = options.accountId ?? DEFAULT_ACCOUNT_ID
  const call = async (accountId: AccountId, method: string, params: ProviderPayload): Promise<SendResult> => {
    const token = options.tokenFor(accountId)
    if (!token) return { ok: false, errorCode: 'not_configured' }
    try {
      const result = await callBotApi({
        method,
        params: { ...params },
        token,
        apiBase: options.apiBase,
        fetch: options.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch),
        signal: new AbortController().signal,
        timeoutMs: BOT_API_TIMEOUT_MS,
      })
      const id = (result as { message_id?: unknown } | null)?.message_id
      return { ok: true, ...(typeof id === 'number' ? { externalId: String(id) } : {}) }
    } catch (err) {
      if (err instanceof PollApiError) {
        return { ok: false, errorCode: err.kind, ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }) }
      }
      return { ok: false, errorCode: 'transient' }
    }
  }
  return {
    kind: 'telegram',
    caps: TELEGRAM_CAPS,
    verify(req: InboundRequest): InboundEvent | null {
      if (!verifyTelegramSecret(req.headers, options.secret).ok) return null
      let update: unknown
      try {
        update = JSON.parse(req.body)
      } catch {
        return null
      }
      const message = parseTelegramUpdate(update)
      if (message) {
        return {
          kind: 'message',
          accountId: account,
          externalEventId: String(message.updateId),
          chatId: message.chatId,
          userId: message.userId,
          isGroup: message.isGroup,
          ...(message.threadId === undefined ? {} : { threadId: String(message.threadId) }),
          text: message.text,
        }
      }
      const cb = parseTelegramCallback(update)
      if (!cb) return null
      return {
        kind: 'callback',
        accountId: account,
        externalEventId: String(cb.updateId),
        chatId: cb.chatId,
        userId: cb.userId,
        isGroup: cb.isGroup,
        ...(cb.threadId === undefined ? {} : { threadId: String(cb.threadId) }),
        text: cb.data,
        callbackId: cb.callbackId,
      }
    },
    render(msg: OutboundMessage): ProviderPayload {
      const head = msg.card ? `${msg.card.title}\n${msg.card.status}\n\n` : ''
      // No parse_mode: untrusted text is delivered literally. The caller adds `chat_id` before `send`.
      const payload: Record<string, unknown> = { text: `${head}${msg.text}`.slice(0, TELEGRAM_CAPS.maxText) }
      if (msg.replyTo !== undefined) payload['reply_to_message_id'] = Number(msg.replyTo)
      if (msg.threadKey !== undefined) payload['message_thread_id'] = Number(msg.threadKey)
      const buttons = (msg.card?.actions ?? []).filter((a) => Buffer.byteLength(a.id) <= CALLBACK_DATA_MAX_BYTES)
      if (buttons.length > 0) {
        payload['reply_markup'] = { inline_keyboard: [buttons.map((a) => ({ text: a.label, callback_data: a.id }))] }
      }
      return payload
    },
    send: (accountId, payload) => call(accountId, 'sendMessage', payload),
    answerCallback: (accountId, callbackId, text) =>
      call(accountId, 'answerCallbackQuery', { callback_query_id: callbackId, text: text.slice(0, 200) }),
  }
}
