// Egress boot (P3): start the outbox drainer only when a bot token exists. A missing token is a
// deployment state, not a fatal error — ingress (webhook + bindings UI) must keep working while the
// human configures the bot, so this logs exactly one redacted line and returns null. Presence is
// resolved through the same precedence as sending (preferred name, then legacy), so boot and send
// can never disagree. The token value is only tested for presence here, never logged or stored.
import {
  TelegramChannelSender,
  startChannelSender,
  type ChannelSenderHandle,
  type FlushResult,
  type SenderStorePort,
  type TelegramSenderFetch,
} from './telegramSender'
import { resolveTelegramBotToken } from './telegramSend'

export const SENDER_DISABLED_LOG =
  'telegram egress disabled: WEBTERM_TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN is not set (ingress stays on)'

export interface SenderBootOptions {
  intervalMs?: number
  /** Test seam: production uses global fetch. */
  fetch?: TelegramSenderFetch
  now?: () => number
}

/** One unref'd interval per runtime, tracked so process exit (and tests) can stop it. */
const running = new Set<ChannelSenderHandle>()
let exitHookInstalled = false

function track(handle: ChannelSenderHandle): void {
  running.add(handle)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const sender of running) sender.stop()
    running.clear()
  })
}

export function startChannelSenderFor(
  store: SenderStorePort,
  env: NodeJS.ProcessEnv,
  options: SenderBootOptions = {}
): ChannelSenderHandle | null {
  if (resolveTelegramBotToken(env) === undefined) {
    console.warn(SENDER_DISABLED_LOG)
    return null
  }
  const sender = new TelegramChannelSender({
    store,
    env: () => env,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const handle = startChannelSender(
    sender,
    options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }
  )
  track(handle)
  console.info('telegram egress: on (outbox drained every few seconds)')
  return handle
}

/** Idle outcome for a runtime without egress, so callers never have to branch on null. */
export const IDLE_FLUSH: FlushResult = {
  busy: false,
  attempted: 0,
  sent: 0,
  retried: 0,
  dead: 0,
  skipped: 0,
  outcomes: [],
}

export function flushChannelSender(handle: ChannelSenderHandle | null): Promise<FlushResult> {
  return handle === null ? Promise.resolve({ ...IDLE_FLUSH }) : handle.flush()
}

export function stopChannelSender(handle: ChannelSenderHandle | null): void {
  if (handle === null) return
  handle.stop()
  running.delete(handle)
}
