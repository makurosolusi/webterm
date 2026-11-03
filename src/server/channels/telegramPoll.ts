// Telegram long-poll ingress (`getUpdates`) for hosts Telegram cannot reach with a webhook.
// Updates go through the SAME dispatcher as the webhook (claimUpdate dedupe, bindings, outbox);
// this module only fetches them and tracks the offset. Telegram refuses getUpdates while a
// webhook is set, so `deleteWebhook` (keeping pending updates) runs before the first poll.
import { resolveTelegramBotToken, type TelegramSenderFetch } from './telegramSend'
import { PollApiError, callBotApi } from './telegramPollApi'
import { redactSecrets } from '../redactSecrets'
import { createLogger } from '../logs'

const log = createLogger('channels.telegram')

export const TELEGRAM_POLL_TIMEOUT_SEC = 25
/** Extra time over the server-side long-poll timeout before the HTTP request is abandoned. */
export const TELEGRAM_POLL_REQUEST_MARGIN_MS = 10_000
export const TELEGRAM_POLL_BACKOFF_BASE_MS = 1_000
export const TELEGRAM_POLL_BACKOFF_MAX_MS = 60_000
export const TELEGRAM_POLL_ALLOWED_UPDATES = ['message', 'callback_query'] as const

export interface TelegramPollStatus {
  ok: boolean
  at: number
  /** Redacted; never contains the bot token. */
  error?: string
}

export interface TelegramPollerOptions {
  /** Highest update id already claimed (the persisted `store.cursor`); polling resumes at +1. */
  cursor: () => number
  /** Same ingest as the webhook route. A throw means the update was NOT consumed. */
  dispatch: (update: unknown) => Promise<unknown>
  env?: NodeJS.ProcessEnv
  fetch?: TelegramSenderFetch
  apiBase?: string
  onStatus?: (status: TelegramPollStatus) => void
  pollTimeoutSec?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  now?: () => number
  random?: () => number
  /** Test seam; must resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface TelegramPoller {
  /** Abort the in-flight request and resolve once the loop has exited. Idempotent. */
  stop(): Promise<void>
  /** Resolves when the loop has ended (stopped or fatal). */
  readonly done: Promise<void>
}

let active: TelegramPoller | null = null

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function updateIdOf(update: unknown): number | undefined {
  const id = (update as { update_id?: unknown } | null)?.update_id
  return typeof id === 'number' && Number.isInteger(id) ? id : undefined
}

/** Start the single per-process poller. Throws when one is already running. */
export function startTelegramPoller(options: TelegramPollerOptions): TelegramPoller {
  if (active) throw new Error('telegram poller: already running in this process')
  const env = options.env ?? process.env
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch)
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? abortableSleep
  const pollSec = options.pollTimeoutSec ?? TELEGRAM_POLL_TIMEOUT_SEC
  const baseMs = options.backoffBaseMs ?? TELEGRAM_POLL_BACKOFF_BASE_MS
  const maxMs = options.backoffMaxMs ?? TELEGRAM_POLL_BACKOFF_MAX_MS
  const ctl = new AbortController()
  const { signal } = ctl

  const report = (status: TelegramPollStatus): void => {
    try {
      options.onStatus?.(status)
    } catch (err) {
      log.warn('telegram.poll.error', `telegram poll: status callback failed: ${redactSecrets(String(err)).slice(0, 200)}`, { stage: 'status_callback' })
    }
  }

  async function run(): Promise<void> {
    log.info('telegram.poll.start', 'telegram poll started')
    let offset = options.cursor() + 1
    let webhookCleared = false
    let failures = 0
    while (!signal.aborted) {
      try {
        const token = resolveTelegramBotToken(env)
        if (!token) throw new PollApiError('fatal', 'bot token is no longer configured')
        const call = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
          callBotApi({ method, params, token, apiBase: options.apiBase, fetch: doFetch, signal, timeoutMs })
        if (!webhookCleared) {
          await call('deleteWebhook', {}, TELEGRAM_POLL_REQUEST_MARGIN_MS)
          webhookCleared = true
        }
        const result = await call(
          'getUpdates',
          { offset, timeout: pollSec, allowed_updates: TELEGRAM_POLL_ALLOWED_UPDATES },
          pollSec * 1000 + TELEGRAM_POLL_REQUEST_MARGIN_MS
        )
        const updates = Array.isArray(result) ? result : []
        for (const update of updates) {
          if (signal.aborted) break
          try {
            await options.dispatch(update)
          } catch (err) {
            throw new PollApiError('transient', redactSecrets(`dispatch failed: ${String(err)}`, [token]).slice(0, 200))
          }
          const id = updateIdOf(update)
          if (id !== undefined) offset = Math.max(offset, id + 1)
        }
        failures = 0
        report({ ok: true, at: now() })
      } catch (err) {
        if (signal.aborted) break
        const failure =
          err instanceof PollApiError
            ? err
            : new PollApiError('transient', redactSecrets(`poll failed: ${String(err)}`).slice(0, 200))
        report({ ok: false, at: now(), error: failure.message })
        if (failure.kind === 'fatal') {
          log.error('telegram.poll.error', `telegram poll stopped: ${failure.message}`, { kind: failure.kind })
          break
        }
        failures += 1
        const backoff = Math.min(maxMs, baseMs * 2 ** (failures - 1))
        const delay = Math.max(failure.retryAfterMs ?? 0, Math.round(backoff * (0.5 + random() / 2)))
        log.warn('telegram.poll.error', `telegram poll: ${failure.message} (retry in ${delay}ms)`, { kind: failure.kind, retryInMs: delay, failures })
        await sleep(delay, signal)
      }
    }
  }

  const done = run().catch((err) => {
    log.error('telegram.poll.error', `telegram poll crashed: ${redactSecrets(String(err)).slice(0, 200)}`, { kind: 'crashed' })
  }).finally(() => {
    log.info('telegram.poll.stop', 'telegram poll ended')
    if (active === poller) active = null
  })
  const poller: TelegramPoller = {
    done,
    stop() {
      ctl.abort()
      return done
    },
  }
  active = poller
  return poller
}
