// HTTP edge for the Telegram channel (P5-3/P3): flag check, secret check, 64 KiB body cap, dedupe,
// dispatch, fast 200, plus the root-only human binding API and the egress drainer. Kept out of
// index.ts so startup stays one readable block and both routes can be exercised without a port.
//
// Enabled only when ALL of these hold; otherwise no route is installed at all:
//   the `telegram` capability is on (isEnabled('telegram'); it is also what the channel master gate follows)
//   webhook mode only: WEBTERM_TELEGRAM_WEBHOOK_SECRET or _SECRET_FILE (Telegram `secret_token`,
//     >= 32 [A-Za-z0-9_-]). Poll mode (WEBTERM_TELEGRAM_MODE) needs only the bot token.
//   WEBTERM_LEDGER=on|shadow (an approval needs the ledger; without it the channel is pointless)
// A corrupt channel store disables the channel too; it is never reset to defaults.
import { isEnabled } from '../featureCapabilities.runtime'
import { join } from 'node:path'
import { dataDir } from '../config'
import { createFileSecretStore } from '../envSecrets.store'
import type { Ledger } from '../ledger/ledger'
import { CHANNEL_STORE_FILE, ChannelStore } from './channelStore'
import { ledgerPersistence } from './channelStoreLedger'
import { defaultWorldCounts } from './channelWorld'
import { presence as processPresence, startAgentForwarder } from './channelPresence'
import { describeAgentNode } from './channelPresenceDescribe'
import { handleChannelPresenceApi } from './channelPresenceHttp'
import { eventBus } from '../events/eventBus'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import {
  ensureWebhookSecret,
  readSecretFile,
  resolveWebhookSecret,
  webhookSecretConfigured,
} from './channelSecret'
import { ledgerApprovalPort, type ChannelsRuntime, type ChannelsRuntimeOptions } from './channelsRuntime.types'
import { FailureThrottle } from './channelThrottle'
import { dispatchTelegramUpdate, type ChannelAuditEvent, type DispatchOutcome } from './channelDispatch'
import { createBackgroundTracker } from './channelButtons'
import { handleChannelBindingsApi } from './channelBindingsHttp'
import { mountBotManager } from './botManager'
import { PendingChatStore } from './channelPending'
import { handleChannelPendingApi } from './channelPendingHttp'
import { handleChannelStatusApi } from './channelStatusHttp'
import { flushChannelSender, startChannelSenderFor, stopChannelSender } from './channelSenderBoot'
import { isWebhookExplicit, resolveTelegramMode } from './telegramMode'
import { resolveTelegramBotToken } from './telegramSend'
import { createLogger } from '../logs'
import { respondToWebhook, safeError, type ChannelWebhookRuntime } from './telegramWebhookHandler'

// Tipe + port ledger tinggal di channelsRuntime.types.ts; re-export supaya import lama tetap sah.
export { ledgerApprovalPort, type ChannelsRuntime, type ChannelsRuntimeOptions } from './channelsRuntime.types'

export const TELEGRAM_WEBHOOK_PATH = '/webhooks/telegram'

// Secret source and throttle live in their own modules; re-exported so this stays the single
// import surface for the server and its tests.
export {
  MAX_WEBHOOK_SECRET_CHARS,
  MIN_WEBHOOK_SECRET_CHARS,
  TELEGRAM_WEBHOOK_SECRET_ENV,
  TELEGRAM_WEBHOOK_SECRET_FILE_ENV,
  readSecretFile,
  resolveWebhookSecret,
  type SecretFileRead,
  type SecretResolution,
} from './channelSecret'
export { WEBHOOK_FAILURE_LIMIT, WEBHOOK_FAILURE_WINDOW_MS } from './channelThrottle'
// Peer identity for the throttle: socket by default, first `x-forwarded-for` only behind an
// explicit `WEBTERM_TRUST_PROXY=on`.
export { TRUST_PROXY_ENV, UNKNOWN_PEER, trustProxyEnabled, webhookPeerKey } from './webhookPeer'
// Webhook request handling lives in its own module; re-exported for the same reason.
export {
  handleTelegramWebhook,
  type ChannelWebhookRequest,
  type ChannelWebhookResponse,
  type ChannelWebhookResponseBody,
  type ChannelWebhookRuntime,
  type WebhookBodyResult,
} from './telegramWebhookHandler'

const log = createLogger('channels')

function logDisabled(reason: string): void {
  log.warn('channels.disabled', `telegram channel disabled: ${reason}`)
}

export function telegramChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabled('telegram', env)
}

/**
 * Wire the channel when it is configured, or return null and leave the server untouched. Any
 * misconfiguration logs one sanitized line and disables the route; it never throws at boot.
 */
export function startChannelsRuntime(
  ledger: Ledger | undefined,
  options: ChannelsRuntimeOptions = {}
): ChannelsRuntime | null {
  const env = options.env ?? process.env
  // Kemampuan telegram off: tak ada route dan secret tak pernah disentuh (kanal ikut telegram, bukan saklar sendiri).
  if (!telegramChannelEnabled(env)) return null

  let mode = resolveTelegramMode(env, false) // index.ts resolves (and warns) once on the same env
  const readSecret = options.readSecret ?? readSecretFile
  // Poll mode never receives a webhook, so the secret is not required (nor read) there.
  let secret: string | undefined
  if (mode === 'webhook') {
    const resolved = resolveWebhookSecret(env, readSecret)
    if (resolved.ok) secret = resolved.secret
    else if (webhookSecretConfigured(env)) return logDisabledAndNull(resolved.reason)
    else if (isWebhookExplicit(env)) {
      // KE-9: webhook hanya bila dipilih eksplisit; secret-nya dibuat otomatis ke secrets/.
      try {
        secret = ensureWebhookSecret(options.secrets ?? createFileSecretStore(join(dataDir(), 'secrets')))
      } catch (err) {
        return logDisabledAndNull(safeError(err))
      }
    } else mode = 'poll' // tanpa token & tanpa secret: tunggu token diisi (hot), jangan matikan kanal
  }
  if (mode === 'poll' && resolveTelegramBotToken(env) === undefined) {
    log.warn('channels.token_missing', 'telegram is on but no bot token is set (poll mode receives no updates without a token)')
  }
  if (!ledger) return logDisabledAndNull('ledger runtime is off (set WEBTERM_LEDGER=on or shadow)')

  let store: ChannelStore
  try {
    // F2-g: the ledger row is the store (channels.json imported once). An explicit `storePath`, or
    // no ledger DB at all (node-env tests with a fake ledger), keeps the JSON file backend.
    const legacy = join(dataDir(), 'channels', CHANNEL_STORE_FILE)
    const db = options.storePath === undefined ? (options.ledgerDb ?? activeLedgerRuntime()?.db) : undefined
    store = new ChannelStore(db ? ledgerPersistence(db, legacy) : (options.storePath ?? legacy), {
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  } catch (err) {
    return logDisabledAndNull(safeError(err))
  }

  const approval = ledgerApprovalPort(ledger)
  const audit = (event: ChannelAuditEvent): void => {
    try {
      ledger.event.appendEvent({ kind: event.kind, actor: 'channel:telegram', payload: event })
    } catch (err) {
      // Audit is best-effort: a missing project row or a busy DB must not break ingress.
      log.warn('channels.audit_failed', `telegram audit append failed: ${safeError(err)}`)
    }
  }
  const pending = options.pending ?? new PendingChatStore(options.now === undefined ? {} : { now: options.now })
  const background = createBackgroundTracker()
  const ingest = (update: unknown): Promise<DispatchOutcome> =>
    dispatchTelegramUpdate(update, {
      store,
      approval,
      audit,
      centralChat: options.centralChat,
      pending,
      background: background.track,
      world: options.world ?? defaultWorldCounts,
      ...(options.buttons ?? {}),
    })
  const runtime: ChannelWebhookRuntime | null = secret === undefined ? null : { secret, dispatch: ingest }
  const throttle = new FailureThrottle(undefined, undefined, options.now ?? Date.now)
  // A missing bot token only disables egress; ingress and the binding API stay available.
  const sender = startChannelSenderFor(store, env, options.sender ?? {})

  const bots = mountBotManager(env, dataDir(), options.bots)
  const presence = options.presence ?? processPresence
  const stopForwarder = startAgentForwarder({
    store,
    presence,
    subscribe: options.subscribe ?? ((pattern, fn) => eventBus.subscribe(pattern, fn)),
    describe: options.describe ?? describeAgentNode,
  })

  log.info('channels.start', `telegram channel started (${mode})`, { mode, egress: sender !== null })
  return {
    store,
    mode,
    ingest,
    idle: background.idle,
    bots,
    get senderRunning() {
      return sender !== null && sender.running
    },
    handle(req, res) {
      const path = new URL(req.url || '/', 'http://x').pathname
      if (runtime === null || path !== TELEGRAM_WEBHOOK_PATH) return false
      void respondToWebhook(req, res, runtime, throttle, env)
      return true
    },
    handleApi(req, res) {
      // Authorization already happened: index.ts only calls this after `allowed`.
      return (
        handleChannelPendingApi(req, res, pending) ||
        handleChannelPresenceApi(req, res, { presence, store }) ||
        handleChannelStatusApi(req, res, { mode, env, pendingCount: () => pending.size(), readSecret }) ||
        handleChannelBindingsApi(req, res, store, undefined, pending)
      )
    },
    flushNow: () => flushChannelSender(sender),
    stop() {
      stopChannelSender(sender)
      stopForwarder()
      log.info('channels.stop', 'telegram channel stopped', { mode })
    },
  }
}

function logDisabledAndNull(reason: string): null {
  logDisabled(reason)
  return null
}

