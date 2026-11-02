// `GET /api/channels/telegram/status`: configuration presence plus in-memory ingress/egress health.
// Authorization is the caller's job (root-token gate before handleApi). Secrets appear only as
// booleans: never a value, never a length.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TELEGRAM_BINDINGS_CHANNEL } from './channelBindingsTypes'
import { writeJson } from './channelHttp'
import {
  TELEGRAM_WEBHOOK_SECRET_ENV,
  TELEGRAM_WEBHOOK_SECRET_FILE_ENV,
  readSecretFile,
  type SecretFileRead,
} from './channelSecret'
import { getChannelStatus } from './channelStatus'
import type { TelegramMode } from './telegramMode'
import { resolveTelegramBotToken } from './telegramSend'

export const TELEGRAM_STATUS_PATH = `/api/channels/${TELEGRAM_BINDINGS_CHANNEL}/status`

export interface ChannelStatusDeps {
  mode: TelegramMode
  env: NodeJS.ProcessEnv
  pendingCount(): number
  readSecret?: (path: string) => SecretFileRead
}

/** True when a webhook secret is configured (env value, or a readable non-empty `_FILE`). */
export function webhookSecretSet(env: NodeJS.ProcessEnv, readFile: (path: string) => SecretFileRead = readSecretFile): boolean {
  if ((env[TELEGRAM_WEBHOOK_SECRET_ENV] ?? '').trim()) return true
  const path = (env[TELEGRAM_WEBHOOK_SECRET_FILE_ENV] ?? '').trim()
  if (!path) return false
  const read = readFile(path)
  return read.ok && read.text.trim() !== ''
}

/** True when this handler owns the request (path matched), false otherwise. */
export function handleChannelStatusApi(req: IncomingMessage, res: ServerResponse, deps: ChannelStatusDeps): boolean {
  if (new URL(req.url || '/', 'http://x').pathname !== TELEGRAM_STATUS_PATH) return false
  req.resume() // no body is read; drain so keep-alive is not left half-consumed
  if ((req.method ?? '').toUpperCase() !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' })
    return true
  }
  const { ingress, egress } = getChannelStatus()
  writeJson(res, 200, {
    mode: deps.mode,
    enabled: true,
    botTokenSet: resolveTelegramBotToken(deps.env) !== undefined,
    webhookSecretSet: webhookSecretSet(deps.env, deps.readSecret),
    pendingCount: deps.pendingCount(),
    ingress,
    egress,
  })
  return true
}
