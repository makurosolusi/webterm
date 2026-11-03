// Editable status card per (bot, chat, topic): sent once, then edited in place. Idempotent (an
// unchanged render makes no API call) and debounced (edits closer than `debounceMs` collapse into one
// trailing refresh). Data comes from an injected provider so this file knows no other workstream.
import type { ControlLevel } from '../central/contracts'
import { createLogger } from '../logs'
import type { BotCall } from './botManager'
import { PollApiError } from './telegramPollApi'

/** Minimum gap between two edits of one card; Telegram throttles frequent edits. */
export const STATUS_CARD_DEBOUNCE_MS = 5_000
const NOT_MODIFIED = 'message is not modified'
const GONE = /message to edit not found|message can't be edited/i
const PERCENT = 100
const log = createLogger('channels')

/** What the card shows; supplied by the provider, never read from internals here. */
export interface StatusSnapshot { level: ControlLevel; activeWorkers: number; budgetUsedTokens: number; budgetLimitTokens: number }
export type StatusProvider = (projectId: string | null) => StatusSnapshot
export interface CardTarget { accountId: string; chatId: string; projectId: string | null; threadId?: number }
export type CardOutcome = 'sent' | 'edited' | 'unchanged' | 'deferred' | 'failed'

/** Compact three-line card text. */
export function renderStatusCard(s: StatusSnapshot): string {
  const pct = s.budgetLimitTokens > 0 ? `${Math.min(PERCENT, Math.round((s.budgetUsedTokens / s.budgetLimitTokens) * PERCENT))}%` : 'n/a'
  return `Central level: ${s.level}\nActive workers: ${s.activeWorkers}\nBudget: ${s.budgetUsedTokens}/${s.budgetLimitTokens} tokens (${pct})`
}

export interface StatusCardDeps {
  call: BotCall
  provider: StatusProvider
  now?: () => number
  debounceMs?: number
  /** Timer seam for tests; default is an unref'd `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void
}

export interface StatusCards {
  /** Sends or edits the card of `target` from the current snapshot. Never throws. */
  refresh(target: CardTarget): Promise<CardOutcome>
}

interface CardState { messageId?: number; lastText: string; lastAt: number; timer: boolean; chain: Promise<unknown> }

/** Builds the card manager; state is per process (a restart posts a fresh card). */
export function createStatusCards(deps: StatusCardDeps): StatusCards {
  const now = deps.now ?? Date.now
  const debounce = deps.debounceMs ?? STATUS_CARD_DEBOUNCE_MS
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
  const cards = new Map<string, CardState>()

  async function apply(target: CardTarget, state: CardState): Promise<CardOutcome> {
    const text = renderStatusCard(deps.provider(target.projectId))
    if (state.messageId !== undefined && text === state.lastText) return 'unchanged'
    if (state.messageId !== undefined && now() - state.lastAt < debounce) {
      if (!state.timer) {
        state.timer = true
        schedule(() => { state.timer = false; void run(target) }, debounce - (now() - state.lastAt))
      }
      return 'deferred'
    }
    try {
      if (state.messageId === undefined) {
        const sent = (await deps.call(target.accountId, 'sendMessage', {
          chat_id: target.chatId, text, ...(target.threadId === undefined ? {} : { message_thread_id: target.threadId }),
        })) as { message_id?: unknown } | null
        if (!Number.isSafeInteger(sent?.message_id)) return 'failed'
        state.messageId = sent?.message_id as number
        state.lastText = text
        state.lastAt = now()
        return 'sent'
      }
      await deps.call(target.accountId, 'editMessageText', { chat_id: target.chatId, message_id: state.messageId, text })
      state.lastText = text
      state.lastAt = now()
      return 'edited'
    } catch (err) {
      const message = err instanceof PollApiError ? err.message : ''
      if (message.includes(NOT_MODIFIED)) { state.lastText = text; return 'unchanged' }
      // A deleted card is re-posted on the next refresh; any other failure keeps the card and retries later.
      if (GONE.test(message)) state.messageId = undefined
      log.warn('bots.card_failed', 'status card update failed', { accountId: target.accountId, kind: err instanceof PollApiError ? err.kind : 'unknown' })
      return 'failed'
    }
  }

  function run(target: CardTarget): Promise<CardOutcome> {
    const key = `${target.accountId}|${target.chatId}|${target.threadId ?? ''}`
    const state = cards.get(key) ?? { lastText: '', lastAt: 0, timer: false, chain: Promise.resolve() }
    cards.set(key, state)
    // Serialized per card so two concurrent refreshes cannot both send a first message.
    const next = state.chain.then(() => apply(target, state))
    state.chain = next
    return next
  }

  return { refresh: run }
}
