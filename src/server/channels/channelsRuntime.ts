// HTTP edge for the Telegram channel (P5-3): flag check, secret check, 64 KiB body cap, dedupe,
// dispatch, fast 200. Kept out of index.ts so server startup stays one readable block and so the
// webhook body can be exercised without binding a port.
//
// Enabled only when ALL of these hold; otherwise no route is installed at all:
//   WEBTERM_TELEGRAM=on
//   WEBTERM_TELEGRAM_WEBHOOK_SECRET or _SECRET_FILE (Telegram `secret_token`, >= 32 [A-Za-z0-9_-])
//   WEBTERM_LEDGER=on|shadow (an approval needs the ledger; without it the channel is pointless)
// A corrupt channel store disables the channel too; it is never reset to defaults.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { dataDir } from '../config'
import type { ApprovalStatus } from '../ledger/ledgerApproval'
import type { Ledger } from '../ledger/ledger'
import { CHANNEL_STORE_FILE, ChannelStore } from './channelStore'
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
import { MAX_WEBHOOK_BODY_BYTES, redactSecrets, verifyTelegramSecret } from './webhook'

export const TELEGRAM_WEBHOOK_PATH = '/webhooks/telegram'
export const TELEGRAM_ENABLED_ENV = 'WEBTERM_TELEGRAM'

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

export type WebhookBodyResult = { ok: true; body: string } | { ok: false; reason: 'too_large' | 'read_failed' }

export interface ChannelWebhookRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  /** Parsed `content-length`, when the provider sent one. */
  declaredLength?: number
  readBody(): Promise<WebhookBodyResult>
}

export type ChannelWebhookResponseBody = { ok: boolean; error?: string; duplicate?: boolean }
export interface ChannelWebhookResponse {
  status: 200 | 400 | 401 | 405 | 413 | 500
  body: ChannelWebhookResponseBody
}

export interface ChannelWebhookRuntime {
  secret: string
  dispatch(update: unknown): Promise<DispatchOutcome>
}

function fail(status: ChannelWebhookResponse['status'], error: string): ChannelWebhookResponse {
  return { status, body: { ok: false, error } }
}

/**
 * Pure webhook entry point. Order is deliberate: method, then size (declared and actual), then
 * the constant-time `secret_token`, then parse, then the idempotent dispatch. Errors never carry
 * the secret, the body, or a stack.
 */
export async function handleTelegramWebhook(
  request: ChannelWebhookRequest,
  runtime: ChannelWebhookRuntime
): Promise<ChannelWebhookResponse> {
  if ((request.method ?? '').toUpperCase() !== 'POST') {
    return fail(405, 'method_not_allowed')
  }
  if (request.declaredLength !== undefined && request.declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return fail(413, 'body_too_large')
  }
  const verified = verifyTelegramSecret(request.headers, runtime.secret)
  if (!verified.ok) return fail(401, verified.reason)

  const body = await request.readBody()
  // One code for both size paths (declared header and streamed overflow); "too_large" stays internal.
  if (!body.ok) {
    return body.reason === 'too_large' ? fail(413, 'body_too_large') : fail(500, 'read_failed')
  }

  let update: unknown
  try {
    update = JSON.parse(body.body)
  } catch {
    return fail(400, 'invalid_json')
  }
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return fail(400, 'invalid_update')
  }

  try {
    const outcome = await runtime.dispatch(update)
    return { status: 200, body: { ok: true, ...(outcome.status === 'duplicate' ? { duplicate: true } : {}) } }
  } catch (err) {
    // The thrown message can only be logged after scrubbing; the client gets a bare 500.
    console.error(`telegram webhook dispatch failed: ${safeError(err)}`)
    return fail(500, 'internal_error')
  }
}

function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error'
  return redactSecrets(text).slice(0, 200)
}

function logDisabled(reason: string): void {
  console.warn(`telegram channel disabled: ${reason}`)
}

export function telegramChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[TELEGRAM_ENABLED_ENV] ?? '').trim().toLowerCase() === 'on'
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
  handle(req: IncomingMessage, res: ServerResponse): boolean
}

export interface ChannelsRuntimeOptions {
  env?: NodeJS.ProcessEnv
  storePath?: string
  now?: () => number
  /** Injection seam for tests; production reads the real filesystem. */
  readSecret?: (path: string) => SecretFileRead
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
  // Flag first: with `WEBTERM_TELEGRAM` off there is no route and the secret is never touched.
  if (!telegramChannelEnabled(env)) return null

  const resolved = resolveWebhookSecret(env, options.readSecret ?? readSecretFile)
  if (!resolved.ok) return logDisabledAndNull(resolved.reason)
  const secret = resolved.secret
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
      console.warn(`telegram audit append failed: ${safeError(err)}`)
    }
  }
  const runtime: ChannelWebhookRuntime = {
    secret,
    dispatch: (update) => dispatchTelegramUpdate(update, { store, approval, audit }),
  }
  const throttle = new FailureThrottle(undefined, undefined, options.now ?? Date.now)

  return {
    store,
    handle(req, res) {
      const path = new URL(req.url || '/', 'http://x').pathname
      if (path !== TELEGRAM_WEBHOOK_PATH) return false
      void respondToWebhook(req, res, runtime, throttle)
      return true
    },
  }
}

function logDisabledAndNull(reason: string): null {
  logDisabled(reason)
  return null
}

async function respondToWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ChannelWebhookRuntime,
  throttle: FailureThrottle
): Promise<void> {
  const peer = req.socket?.remoteAddress ?? 'unknown'
  const blockedFor = throttle.retryAfterSeconds(peer)
  if (blockedFor !== null) {
    writeJson(res, 429, { ok: false, error: 'too_many_requests' }, { 'Retry-After': String(blockedFor) })
    return
  }
  let result: ChannelWebhookResponse
  try {
    result = await handleTelegramWebhook(
      {
        method: req.method,
        headers: req.headers,
        declaredLength: declaredLength(req.headers['content-length']),
        readBody: () => readCappedBody(req),
      },
      runtime
    )
  } catch {
    result = fail(500, 'internal_error')
  }
  if (result.status === 401) throttle.recordFailure(peer)
  writeJson(res, result.status, result.body)
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: ChannelWebhookResponseBody,
  extraHeaders: Record<string, string> = {}
): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
  res.end(JSON.stringify(body))
}

function declaredLength(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || !/^\d{1,12}$/.test(value)) return undefined
  return Number(value)
}

/** Read with a hard byte cap. The overflow path drops the listener and drains, so the 413 can be
 *  written without buffering an unbounded body (a declared length is not trusted). */
function readCappedBody(req: IncomingMessage): Promise<WebhookBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const finish = (result: WebhookBodyResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        req.resume()
        finish({ ok: false, reason: 'too_large' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') })
    const onError = (): void => finish({ ok: false, reason: 'read_failed' })
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
