// Production wiring for Telegram approval buttons (CA2 WS-19): the ledger-backed challenge lookup, the
// Bot API spinner dismissal and a tracker for detached central turns. On by default (zero-config: the
// inbox sends every gate as a card with Approve once / Deny, F3-a); WEBTERM_CHANNEL_APPROVAL_BUTTONS=off
// (Settings > Channels) is the explicit off switch, after which a `callback_query` stays ignored.
import type { Database } from 'bun:sqlite'
import { flagOr } from '../envFlag'
import { getRow } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import type { ApprovalChallengePort } from './channelCallback'
import type { TelegramDispatchDeps } from './channelDispatch'
import { PollApiError, callBotApi } from './telegramPollApi'
import { resolveTelegramBotToken, type TelegramSenderFetch } from './telegramSend'

const log = createLogger('channels.buttons')
const ANSWER_TIMEOUT_MS = 5_000
const ANSWER_TEXT_MAX = 200

export const CHANNEL_APPROVAL_BUTTONS_ENV = 'WEBTERM_CHANNEL_APPROVAL_BUTTONS'

/** Buttons are processed unless explicitly switched off; a typo keeps the default (on). */
export const approvalButtonsOn = (env: NodeJS.ProcessEnv): boolean => flagOr(env[CHANNEL_APPROVAL_BUTTONS_ENV], true)

/** Reads the digest + nonce of a still-pending approval; anything else is no longer a valid card. */
export function ledgerChallengePort(db: Database): ApprovalChallengePort {
  return {
    challengeFor(approvalId) {
      const row = getRow(
        db,
        `SELECT d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id
         WHERE a.id = ? AND a.status = 'pending'`,
        approvalId
      )
      if (!row || row['action_digest'] == null || row['nonce'] == null) return null
      return { digest: String(row['action_digest']), nonce: String(row['nonce']) }
    },
  }
}

/** Tracks detached tasks (they never reject) so shutdown and tests can wait for them. */
export function createBackgroundTracker(): { track(task: Promise<void>): void; idle(): Promise<void> } {
  const live = new Set<Promise<void>>()
  return {
    track(task) {
      live.add(task)
      void task.finally(() => live.delete(task))
    },
    async idle() {
      while (live.size > 0) await Promise.allSettled([...live])
    },
  }
}

export interface ButtonDepsOptions {
  env?: NodeJS.ProcessEnv
  fetch?: TelegramSenderFetch
  signal?: AbortSignal
}

/** Challenge + answerCallback deps, or null when switched off (the dispatcher then ignores callbacks). */
export function buildButtonDeps(
  db: Database,
  options: ButtonDepsOptions = {}
): Pick<TelegramDispatchDeps, 'challenge' | 'answerCallback'> | null {
  const env = options.env ?? process.env
  if (!approvalButtonsOn(env)) return null
  const send = options.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch)
  return {
    challenge: ledgerChallengePort(db),
    async answerCallback(callbackId, text) {
      const token = resolveTelegramBotToken(env)
      if (token === undefined) return
      try {
        await callBotApi({
          method: 'answerCallbackQuery',
          params: { callback_query_id: callbackId, text: text.slice(0, ANSWER_TEXT_MAX) },
          token,
          fetch: send,
          signal: options.signal ?? new AbortController().signal,
          timeoutMs: ANSWER_TIMEOUT_MS,
        })
      } catch (err) {
        // Best effort: the decision is already durable; a stuck spinner clears itself client-side.
        log.warn('channels.answer_callback_failed', 'answerCallbackQuery failed', {
          error: err instanceof PollApiError ? err.message : err instanceof Error ? err.name : typeof err,
        })
      }
    },
  }
}
