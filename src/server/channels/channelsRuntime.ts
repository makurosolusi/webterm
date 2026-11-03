// HTTP edge for the Telegram channel (P5-3/P3): flag check, secret check, 64 KiB body cap, dedupe,
// dispatch, fast 200, plus the root-only human binding API and the egress drainer. Kept out of
// index.ts so startup stays one readable block and both routes can be exercised without a port.
//
// Enabled only when ALL of these hold; otherwise no route is installed at all:
//   WEBTERM_CHANNELS is unset or `on` (master kill switch; see channelsMasterState)
//   WEBTERM_TELEGRAM=on
//   webhook mode only: WEBTERM_TELEGRAM_WEBHOOK_SECRET or _SECRET_FILE (Telegram `secret_token`,
//     >= 32 [A-Za-z0-9_-]). Poll mode (WEBTERM_TELEGRAM_MODE) needs only the bot token.
//   WEBTERM_LEDGER=on|shadow (an approval needs the ledger; without it the channel is pointless)
// A corrupt channel store disables the channel too; it is never reset to defaults.
import { flagOn } from '../envFlag'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { dataDir } from '../config'
import type { ApprovalStatus } from '../ledger/ledgerApproval'
import type { Ledger } from '../ledger/ledger'
import { CHANNEL_STORE_FILE, ChannelStore } from './channelStore'
import { CHANNELS_MASTER_ENV, CHANNELS_MASTER_VALUES, channelsMasterState } from './channelsMasterGate'
import {
  readSecretFile,
  resolveWebhookSecret,
  type SecretFileRead,
} from './channelSecret'
import { FailureThrottle } from './channelThrottle'
import {
  dispatchTelegramUpdate,
  type ChannelApprovalPort,
  type ChannelAuditEvent,
  type DispatchOutcome,
} from './channelDispatch'
import type { TelegramCentralPort } from './channelDispatch'
import { handleChannelBindingsApi } from './channelBindingsHttp'
import { mountBotManager, type BotManager, type BotManagerDeps } from './botManager'
import { PendingChatStore } from './channelPending'
import { handleChannelPendingApi } from './channelPendingHttp'
import { handleChannelStatusApi } from './channelStatusHttp'
import {
  flushChannelSender,
  startChannelSenderFor,
  stopChannelSender,
  type SenderBootOptions,
} from './channelSenderBoot'
import type { FlushResult } from './telegramSender'
import { resolveTelegramMode, type TelegramMode } from './telegramMode'
import { resolveTelegramBotToken } from './telegramSend'
import { createLogger } from '../logs'
import { respondToWebhook, safeError, type ChannelWebhookRuntime } from './telegramWebhookHandler'

export const TELEGRAM_WEBHOOK_PATH = '/webhooks/telegram'
export const TELEGRAM_ENABLED_ENV = 'WEBTERM_TELEGRAM'

// Master kill switch lives in its own module; re-exported here as the single import surface.
export {
  CHANNELS_MASTER_ENV,
  CHANNELS_MASTER_VALUES,
  channelsMasterState,
  type ChannelsMasterState,
} from './channelsMasterGate'

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
  return flagOn(env[TELEGRAM_ENABLED_ENV])
}

/** Production approval port: the real ledger, unchanged, behind the dispatcher's narrow slice. */
export function ledgerApprovalPort(ledger: Ledger): ChannelApprovalPort {
  return {
    listApprovals: (opts) =>
      ledger.approval.listApprovals({
        projectId: opts?.projectId,
        status: opts?.status as ApprovalStatus | undefined,
        limit: opts?.limit,
      }),
    getApproval: (id) => ledger.approval.getApproval(id),
    decideApproval: (id, input) => ledger.approval.decideApproval(id, input),
    consumeApproval: (id, input) => ledger.approval.consumeApproval(id, input),
  }
}

export interface ChannelsRuntime {
  store: ChannelStore
  /** Ingress mode this runtime was booted in; poll mode installs no webhook route. */
  readonly mode: TelegramMode
  /** Same dedupe + dispatch + pending path as the webhook; the poller feeds updates through it. */
  ingest(update: unknown): Promise<DispatchOutcome>
  /** True when the egress interval is running (a bot token was configured at boot). */
  readonly senderRunning: boolean
  /** Managed bots manager; null unless WEBTERM_CENTRAL_BOTS=on. */
  readonly bots: BotManager | null
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** Root-only binding CRUD. The caller MUST authorize first; false for any other path. */
  handleApi(req: IncomingMessage, res: ServerResponse): boolean
  /** Drain the reply outbox now; resolves to an idle result when egress is not configured. */
  flushNow(): Promise<FlushResult>
  /** Stop the egress interval. Safe to call more than once. */
  stop(): void
}

export interface ChannelsRuntimeOptions {
  env?: NodeJS.ProcessEnv
  storePath?: string
  now?: () => number
  /** Injection seam for tests; production reads the real filesystem. */
  readSecret?: (path: string) => SecretFileRead
  /** Egress pacing and transport seam; omitted in production (5s interval, global fetch). */
  sender?: SenderBootOptions
  centralChat?: TelegramCentralPort
  /** Test seam for the managed bots manager (secrets, registry, fetch). */
  bots?: Partial<BotManagerDeps>
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
  // Master switch first: `off` short-circuits even when Telegram itself is on.
  const master = channelsMasterState(env)
  if (master !== 'on') {
    // Never echo the raw value: it is operator input and this line goes to shared logs.
    if (master === 'unsupported') {
      logDisabled(`unsupported ${CHANNELS_MASTER_ENV} value; supported: ${CHANNELS_MASTER_VALUES} (staying off)`)
    }
    return null
  }
  // Flag next: with `WEBTERM_TELEGRAM` off there is no route and the secret is never touched.
  if (!telegramChannelEnabled(env)) return null

  const mode = resolveTelegramMode(env, false) // index.ts resolves (and warns) once on the same env
  const readSecret = options.readSecret ?? readSecretFile
  // Poll mode never receives a webhook, so the secret is not required (nor read) there.
  let secret: string | undefined
  if (mode === 'webhook') {
    const resolved = resolveWebhookSecret(env, readSecret)
    if (!resolved.ok) return logDisabledAndNull(resolved.reason)
    secret = resolved.secret
  } else if (resolveTelegramBotToken(env) === undefined) {
    log.warn('channels.token_missing', 'telegram on tetapi bot token belum diset (mode poll tidak menerima update tanpa token)')
  }
  if (!ledger) return logDisabledAndNull('ledger runtime is off (set WEBTERM_LEDGER=on or shadow)')

  let store: ChannelStore
  try {
    store = new ChannelStore(options.storePath ?? join(dataDir(), 'channels', CHANNEL_STORE_FILE), {
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
  const pending = new PendingChatStore(options.now === undefined ? {} : { now: options.now })
  const ingest = (update: unknown): Promise<DispatchOutcome> =>
    dispatchTelegramUpdate(update, { store, approval, audit, centralChat: options.centralChat, pending })
  const runtime: ChannelWebhookRuntime | null = secret === undefined ? null : { secret, dispatch: ingest }
  const throttle = new FailureThrottle(undefined, undefined, options.now ?? Date.now)
  // A missing bot token only disables egress; ingress and the binding API stay available.
  const sender = startChannelSenderFor(store, env, options.sender ?? {})

  const bots = mountBotManager(env, dataDir(), options.bots)

  log.info('channels.start', `telegram channel started (${mode})`, { mode, egress: sender !== null })
  return {
    store,
    mode,
    ingest,
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
        handleChannelStatusApi(req, res, { mode, env, pendingCount: () => pending.size(), readSecret }) ||
        handleChannelBindingsApi(req, res, store, undefined, pending)
      )
    },
    flushNow: () => flushChannelSender(sender),
    stop() {
      stopChannelSender(sender)
      log.info('channels.stop', 'telegram channel stopped', { mode })
    },
  }
}

function logDisabledAndNull(reason: string): null {
  logDisabled(reason)
  return null
}

