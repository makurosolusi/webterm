// Telegram egress (P3): drains the durable reply outbox through the Bot API. Transport lives in
// `telegramSend.ts` (token from env at send time, timeout, response validation, redaction); this
// file owns queue draining, backoff, and the interval. Sending never throws into the ledger.
import { logEgressFailed, logEgressInternal, logEgressSent } from './telegramEgressLog'
import type { StoredReply } from './channelStoreSchema'
import {
  TELEGRAM_SEND_TIMEOUT_MS,
  sendTelegramMarkdown,
  type TelegramSenderFetch,
} from './telegramSend'

export {
  TELEGRAM_SEND_TIMEOUT_MS,
  sendTelegramMarkdown,
  sendTelegramMessage,
  type TelegramSendFailureReason,
  type TelegramSendInput,
  type TelegramSendOptions,
  type TelegramSendResult,
  type TelegramSenderFetch,
  type TelegramSenderResponse,
} from './telegramSend'

export const TELEGRAM_SEND_MAX_ATTEMPTS = 5
export const TELEGRAM_SEND_BASE_DELAY_MS = 1_000
export const TELEGRAM_SEND_MAX_DELAY_MS = 60_000

/** Exponential backoff with a hard ceiling: attempt 1 = base, 2 = 2x, 3 = 4x, ... */
function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
}

/** The slice of ChannelStore the sender needs; tests pass a fake. */
export interface SenderStorePort {
  pendingReplies(): StoredReply[]
  markReplySent(key: string): boolean
  markReplyFailed(key: string, change: { nextAt: number; error?: string; dead?: boolean; chunksDone?: number }): boolean
}

export interface TelegramChannelSenderOptions {
  store: SenderStorePort
  fetch?: TelegramSenderFetch
  /** Test seam only: production reads process.env at send time. */
  env?: () => NodeJS.ProcessEnv
  now?: () => number
  apiBase?: string
  timeoutMs?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export type FlushStatus = 'sent' | 'retry' | 'dead' | 'skipped' | 'store_error'

export interface FlushOutcome {
  key: string
  status: FlushStatus
  error?: string
}

export interface FlushResult {
  busy: boolean
  attempted: number
  sent: number
  retried: number
  dead: number
  skipped: number
  outcomes: FlushOutcome[]
}

interface ReplyRuntime {
  attempts: number
  nextAt: number
  /** Accepted chunks, kept in memory too so a failed progress write still never re-sends one. */
  chunksDone: number
}

/** Drains pending ChannelStore replies, oldest-first, with per-reply exponential backoff. */
export class TelegramChannelSender {
  private readonly store: SenderStorePort
  private readonly fetch?: TelegramSenderFetch
  private readonly env?: () => NodeJS.ProcessEnv
  private readonly clock: () => number
  private readonly apiBase?: string
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly runtime = new Map<string, ReplyRuntime>()
  private flushing = false

  constructor(options: TelegramChannelSenderOptions) {
    this.store = options.store
    this.fetch = options.fetch
    this.env = options.env
    this.clock = options.now ?? Date.now
    this.apiBase = options.apiBase
    this.timeoutMs = options.timeoutMs ?? TELEGRAM_SEND_TIMEOUT_MS
    this.maxAttempts = Math.max(1, options.maxAttempts ?? TELEGRAM_SEND_MAX_ATTEMPTS)
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? TELEGRAM_SEND_BASE_DELAY_MS)
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? TELEGRAM_SEND_MAX_DELAY_MS)
  }

  /** Never throws. A concurrent call returns `busy` instead of double-sending. */
  async flushOnce(): Promise<FlushResult> {
    const result: FlushResult = {
      busy: false,
      attempted: 0,
      sent: 0,
      retried: 0,
      dead: 0,
      skipped: 0,
      outcomes: [],
    }
    if (this.flushing) return { ...result, busy: true }
    this.flushing = true
    try {
      const rows = this.store
        .pendingReplies()
        .map((row, index) => ({ row, index }))
        .sort((a, b) => a.row.createdAt - b.row.createdAt || a.index - b.index)
        .map((entry) => entry.row)
      const now = this.clock()
      for (const row of rows) {
        const runtime = this.runtime.get(row.key) ?? {
          attempts: row.attempts,
          nextAt: row.nextAt ?? row.createdAt,
          chunksDone: row.chunksDone ?? 0,
        }
        this.runtime.set(row.key, runtime)
        if (runtime.nextAt > now) {
          result.skipped += 1
          continue
        }

        const send = await sendTelegramMarkdown(
          {
            chatId: row.chatId,
            text: row.text,
            fromChunk: runtime.chunksDone,
            ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
          },
          {
            ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
            ...(this.env === undefined ? {} : { env: this.env }),
            ...(this.apiBase === undefined ? {} : { apiBase: this.apiBase }),
            timeoutMs: this.timeoutMs,
          }
        )
        result.attempted += 1
        runtime.chunksDone = send.chunksDone
        const fields = {
          key: row.key,
          chatId: row.chatId,
          textLength: row.text.length,
          attempt: runtime.attempts + 1,
          status: send.status,
        }

        if (send.ok) {
          logEgressSent(fields, this.clock())
          if (this.persist('mark_sent', () => this.store.markReplySent(row.key))) {
            this.runtime.delete(row.key)
            result.sent += 1
            result.outcomes.push({ key: row.key, status: 'sent' })
          } else {
            result.outcomes.push({ key: row.key, status: 'store_error' })
          }
          continue
        }

        if (send.reason === 'not_configured') {
          // A missing token is a deployment state, not a failed attempt: keep the row pending so
          // configuring the bot later drains the queue instead of dead-lettering it.
          result.skipped += 1
          result.outcomes.push({ key: row.key, status: 'skipped', error: send.error })
          continue
        }

        const attempts = runtime.attempts + 1
        const dead = !send.retryable || attempts >= this.maxAttempts
        const delay = Math.max(
          send.retryAfterMs ?? 0,
          backoffDelayMs(attempts, this.baseDelayMs, this.maxDelayMs)
        )
        runtime.attempts = attempts
        runtime.nextAt = dead ? now : now + Math.min(this.maxDelayMs, delay)
        logEgressFailed(
          { ...fields, ...(send.errorCode === undefined ? {} : { errorCode: send.errorCode }) },
          this.clock(),
          send.error,
          dead ? 'dead' : 'retry'
        )
        const stored = this.persist('mark_failed', () =>
          this.store.markReplyFailed(row.key, {
            nextAt: runtime.nextAt,
            error: send.error,
            dead,
            chunksDone: send.chunksDone,
          })
        )
        if (!stored) {
          result.outcomes.push({ key: row.key, status: 'store_error', error: send.error })
        } else if (dead) {
          this.runtime.delete(row.key)
          result.dead += 1
          result.outcomes.push({ key: row.key, status: 'dead', error: send.error })
        } else {
          result.retried += 1
          result.outcomes.push({ key: row.key, status: 'retry', error: send.error })
        }
      }
      return result
    } catch (err) {
      // Even a throwing store port must not propagate into the ledger/interval caller.
      logEgressInternal('flush', err, this.clock())
      result.outcomes.push({ key: '', status: 'store_error' })
      return result
    } finally {
      this.flushing = false
    }
  }

  private persist(name: string, operation: () => boolean): boolean {
    try {
      const ok = operation()
      if (!ok) logEgressInternal(name, new Error('store_rejected_update'), this.clock())
      return ok
    } catch (err) {
      logEgressInternal(name, err, this.clock())
      return false
    }
  }
}

export interface ChannelSenderHandle {
  /** Stop the interval. Safe to call more than once. */
  stop(): void
  readonly running: boolean
  /** Run one flush now (used by tests and by a manual "send now" control). */
  flush(): Promise<FlushResult>
}

export interface StartChannelSenderOptions {
  intervalMs?: number
  immediate?: boolean
}

/**
 * Periodically drains the outbox. `unref` keeps the timer from holding the process open. A tick
 * that lands while the previous flush is still running is dropped, so sends never overlap.
 */
export function startChannelSender(
  sender: Pick<TelegramChannelSender, 'flushOnce'>,
  options: StartChannelSenderOptions = {}
): ChannelSenderHandle {
  const intervalMs = Math.max(250, options.intervalMs ?? 5_000)
  let stopped = false
  let inFlight = false
  const flush = async (): Promise<FlushResult> => sender.flushOnce()
  const tick = (): void => {
    if (stopped || inFlight) return
    inFlight = true
    void flush()
      .catch((err: unknown) => logEgressInternal('tick', err, Date.now()))
      .finally(() => {
        inFlight = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  if (options.immediate) tick()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    get running() {
      return !stopped
    },
    flush,
  }
}
