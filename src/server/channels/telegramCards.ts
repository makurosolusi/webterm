// Generic Telegram card sender (F3-a): one HTML message with optional inline buttons, plus the
// renderer for inbox items. A gate card carries exactly two buttons, "Approve once" and "Deny",
// whose `callback_data` is `channelCallback.approvalCallbackData`, so a press takes the existing
// callback path (`dispatchTelegramCallback` -> `handleApprove`/`handleReject`) and decides the same
// ledger approval as the canvas. There is never an "always" button: a permanent rule is UI-only (K4).
import type { InboxEntry } from '../inbox/inboxItemModel'
import { impactLine } from '../inbox/inboxItemModel'
import { createLogger } from '../logs'
import { approvalCallbackData } from './channelCallback'
import { escapeTelegramHtml } from './telegramFormat'
import { PollApiError, callBotApi } from './telegramPollApi'
import { TELEGRAM_HTML_PARAMS, TELEGRAM_SEND_TIMEOUT_MS, resolveTelegramBotToken, type TelegramSenderFetch } from './telegramSend'

const log = createLogger('channels')
/** Keeps a card well under the 4096-char Bot API limit, so it is never split or cut mid-tag. */
const BODY_MAX = 1500

export interface CardButton { text: string; data: string }
export interface TelegramCard { html: string; buttons: CardButton[] }

export interface CardSendOptions {
  fetch?: TelegramSenderFetch
  env?: NodeJS.ProcessEnv
  apiBase?: string
  signal?: AbortSignal
}

/** Sends one card. Returns false (logged, token never echoed) on any failure; never throws. */
export async function sendTelegramCard(chatId: string, card: TelegramCard, options: CardSendOptions = {}): Promise<boolean> {
  const token = resolveTelegramBotToken(options.env ?? process.env)
  if (token === undefined) return false
  const params: Record<string, unknown> = { chat_id: chatId, text: card.html, ...TELEGRAM_HTML_PARAMS }
  if (card.buttons.length > 0) params['reply_markup'] = { inline_keyboard: [card.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] }
  try {
    await callBotApi({
      method: 'sendMessage', params, token,
      fetch: options.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch),
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: TELEGRAM_SEND_TIMEOUT_MS,
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    })
    return true
  } catch (err) {
    log.warn('telegram.card.fail', 'telegram card send failed', { error: err instanceof PollApiError ? err.message : err instanceof Error ? err.name : typeof err })
    return false
  }
}

const HEADING: Record<InboxEntry['kind'], string> = {
  gate: 'Approval needed',
  question: 'An agent has a question',
  review: 'Ready for review',
  notify: 'Update',
}

/**
 * Plain-text notice for one inbox item: what the Central conversation shows (conversationNotice.ts),
 * and the same words the Telegram card carries, so both surfaces read from one source.
 */
export function inboxNoticeText(item: InboxEntry, projectName?: string | null): string {
  const parts = [`${HEADING[item.kind]}: ${item.title}`]
  if (item.impact) parts.push(impactLine(item.impact))
  if (projectName) parts.push(`project ${projectName}`)
  return parts.join(' — ')
}

/** Card for one inbox item; untrusted text is escaped. Gate = Approve once / Deny, nothing else. */
export function renderInboxCard(item: InboxEntry, projectName?: string | null): TelegramCard {
  const lines = [`<b>${HEADING[item.kind]}</b>`, escapeTelegramHtml(item.title)]
  if (item.impact) lines.push(`<i>${escapeTelegramHtml(impactLine(item.impact))}</i>`)
  if (item.body) lines.push('', escapeTelegramHtml(item.body.slice(0, BODY_MAX)))
  if (projectName) lines.push('', `Project: ${escapeTelegramHtml(projectName)}`)
  const buttons: CardButton[] = []
  if (item.kind === 'gate' && item.approvalId) {
    const yes = approvalCallbackData(item.approvalId, true)
    const no = approvalCallbackData(item.approvalId, false)
    if (yes && no) buttons.push({ text: 'Approve once', data: yes }, { text: 'Deny', data: no })
  }
  if (buttons.length === 0 && item.kind !== 'notify') lines.push('', 'Open webterm to answer.')
  return { html: lines.join('\n'), buttons }
}
