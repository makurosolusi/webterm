// Boot-time glue for Telegram ingress: mode selection (poll vs webhook), the poller bound to the
// channel runtime's store, and the central-chat gate. Lives here so index.ts stays declarative.
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { centralRuntimeKind } from '../central/runtime/runtimeFlag'
import type { RuntimeKind } from '../central/runtime/centralRuntime'
import { recordIngress } from './channelStatus'
import type { TelegramCentralPort } from './channelDispatch'
import type { ChannelsRuntime } from './channelsRuntime'
import { centralTelegramEnabled, createTelegramCentralPort } from './telegramCentralBridge'
import { startTelegramPoller, type TelegramPoller, type TelegramPollStatus } from './telegramPoll'
import { resolveTelegramBotToken } from './telegramSend'

// Mode selection lives in telegramMode.ts; re-exported so this stays the boot-glue import surface.
export { TELEGRAM_MODE_ENV, resolveTelegramMode, type TelegramMode } from './telegramMode'

const CENTRAL_RUNTIME_ENV = 'WEBTERM_CENTRAL_RUNTIME'

/**
 * Central-chat bridge for Telegram, or undefined unless EVERY gate holds: capabilities central +
 * telegram (same central gate as the HTTP chat API), a live ledger, runtime != off.
 */
export function buildTelegramCentralPort(
  runtime: Pick<LedgerRuntime, 'db'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  create: typeof createTelegramCentralPort = createTelegramCentralPort
): TelegramCentralPort | undefined {
  if (!runtime || !centralTelegramEnabled(env)) return undefined
  const kind: RuntimeKind = centralRuntimeKind(env[CENTRAL_RUNTIME_ENV])
  return kind === 'off' ? undefined : create({ db: runtime.db, kind })
}

export interface TelegramInboundInput {
  channels: ChannelsRuntime
  /** Unused since dispatch moved into `channels.ingest`; kept so existing call sites compile. */
  ledger?: LedgerRuntime
  /** Unused: the runtime's `ingest` already carries the central port; kept for call-site compat. */
  centralChat?: TelegramCentralPort
  env?: NodeJS.ProcessEnv
  /** Extra status observer; poll outcomes are always recorded as channel ingress status. */
  onStatus?: (status: TelegramPollStatus) => void
}

/**
 * Start the long-poll ingress on the channel runtime's own `ingest` (same dedupe, dispatch and
 * pending list as the webhook). Returns null when no bot token is configured; the runtime has
 * already logged that, so this stays silent.
 */
export function startTelegramInbound(input: TelegramInboundInput): TelegramPoller | null {
  const env = input.env ?? process.env
  if (!resolveTelegramBotToken(env)) return null
  const poller = startTelegramPoller({
    env,
    cursor: () => input.channels.store.snapshot().cursor,
    dispatch: (update) => input.channels.ingest(update),
    onStatus: (status) => {
      recordIngress(status.ok ? { ok: true, at: status.at } : { ok: false, at: status.at, error: status.error })
      input.onStatus?.(status)
    },
  })
  // Dilepas saat loop selesai: start/stop hot berulang tidak menumpuk listener `exit`.
  const onExit = (): void => void poller.stop()
  process.once('exit', onExit)
  void poller.done.finally(() => process.off('exit', onExit))
  return poller
}
