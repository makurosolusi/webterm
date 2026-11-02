// Boot-time glue for Telegram ingress: mode selection (poll vs webhook), the poller bound to the
// channel runtime's store, and the central-chat gate. Lives here so index.ts stays declarative.
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { centralEnabled } from '../central/centralModel'
import { centralRuntimeKind } from '../central/runtime/runtimeFlag'
import type { RuntimeKind } from '../central/runtime/centralRuntime'
import { dispatchTelegramUpdate, type ChannelAuditEvent, type TelegramCentralPort } from './channelDispatch'
import { ledgerApprovalPort, type ChannelsRuntime } from './channelsRuntime'
import { centralTelegramEnabled, createTelegramCentralPort } from './telegramCentralBridge'
import { startTelegramPoller, type TelegramPoller, type TelegramPollStatus } from './telegramPoll'
import { resolveTelegramBotToken } from './telegramSend'
import { redactSecrets } from './webhook'

export const TELEGRAM_MODE_ENV = 'WEBTERM_TELEGRAM_MODE'
export const TELEGRAM_CENTRAL_CHAT_ENV = 'WEBTERM_CENTRAL_CHAT'
const CENTRAL_TELEGRAM_ENV = 'WEBTERM_CENTRAL_TELEGRAM'
const CENTRAL_ENV = 'WEBTERM_CENTRAL'
const CENTRAL_RUNTIME_ENV = 'WEBTERM_CENTRAL_RUNTIME'
export type TelegramMode = 'poll' | 'webhook'

/**
 * Ingress mode. Explicit `poll`/`webhook` wins; unset (or unsupported) means `poll` when a bot
 * token exists, else `webhook` (the legacy behavior, which needs no token to receive).
 */
export function resolveTelegramMode(env: NodeJS.ProcessEnv = process.env): TelegramMode {
  const raw = (env[TELEGRAM_MODE_ENV] ?? '').trim().toLowerCase()
  if (raw === 'poll' || raw === 'webhook') return raw
  if (raw !== '') console.warn(`telegram channel: unsupported ${TELEGRAM_MODE_ENV} value ignored; supported: poll, webhook`)
  return resolveTelegramBotToken(env) ? 'poll' : 'webhook'
}

/**
 * Central-chat bridge for Telegram, or undefined unless EVERY gate holds: chat flag, Telegram
 * flag, `WEBTERM_CENTRAL=on` (same gate as the HTTP chat API), a live ledger, runtime != off.
 */
export function buildTelegramCentralPort(
  runtime: Pick<LedgerRuntime, 'db'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  create: typeof createTelegramCentralPort = createTelegramCentralPort
): TelegramCentralPort | undefined {
  if (env[TELEGRAM_CENTRAL_CHAT_ENV] !== 'on' || !runtime) return undefined
  if (!centralTelegramEnabled(env[CENTRAL_TELEGRAM_ENV]) || !centralEnabled(env[CENTRAL_ENV])) return undefined
  const kind: RuntimeKind = centralRuntimeKind(env[CENTRAL_RUNTIME_ENV])
  return kind === 'off' ? undefined : create({ db: runtime.db, kind })
}

/**
 * `ingest` is the webhook's own dispatch (shares the pending-chat list). ChannelsRuntime does not
 * expose it yet; when it does, the poller picks it up here with no further change.
 */
export type IngestingChannels = ChannelsRuntime & { ingest?: (update: unknown) => Promise<unknown> }

export interface TelegramInboundInput {
  channels: IngestingChannels
  ledger: LedgerRuntime
  centralChat?: TelegramCentralPort
  env?: NodeJS.ProcessEnv
  onStatus?: (status: TelegramPollStatus) => void
}

/**
 * Start the long-poll ingress bound to the channel runtime's store and the same dispatcher the
 * webhook uses. Returns null (with one log line) when no bot token is configured.
 */
export function startTelegramInbound(input: TelegramInboundInput): TelegramPoller | null {
  const env = input.env ?? process.env
  if (!resolveTelegramBotToken(env)) {
    console.warn('telegram poll disabled: WEBTERM_TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN is not set')
    return null
  }
  const { store } = input.channels
  const approval = ledgerApprovalPort(input.ledger.ledger)
  const audit = (event: ChannelAuditEvent): void => {
    try {
      input.ledger.ledger.event.appendEvent({ kind: event.kind, actor: 'channel:telegram', payload: event })
    } catch (err) {
      console.warn(`telegram audit append failed: ${redactSecrets(String(err)).slice(0, 200)}`)
    }
  }
  const poller = startTelegramPoller({
    env,
    cursor: () => store.snapshot().cursor,
    dispatch:
      input.channels.ingest ??
      ((update) => dispatchTelegramUpdate(update, { store, approval, audit, centralChat: input.centralChat })),
    onStatus: input.onStatus,
  })
  process.once('exit', () => void poller.stop())
  return poller
}
