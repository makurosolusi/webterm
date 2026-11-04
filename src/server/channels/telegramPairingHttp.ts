// `POST /api/channels/telegram/pairing` {projectId} -> a one-time deep link for the Settings card.
// Authorization is the caller's job (index.ts root-token gate before handleApi), as for bindings.
// The bot username comes from `getMe` on the running bot token; the token never leaves the server.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readCappedRequestBody } from '../cappedRequestBody'
import { listWorkspaces, lookupWorkspace } from '../central/workspaceLookup'
import { MAX_PROJECT_ID_CHARS } from './channelBindingsTypes'
import { cleanText, isRecord } from './channelBindingsValidation'
import { writeJson } from './channelHttp'
import type { PairingCodes } from './telegramPairing'
import { callBotApi } from './telegramPollApi'
import { resolveTelegramBotToken, type TelegramSenderFetch } from './telegramSend'

export const TELEGRAM_PAIRING_PATH = '/api/channels/telegram/pairing'
const BODY_LIMIT_BYTES = 4 * 1024
const GET_ME_TIMEOUT_MS = 10_000

export interface PairingRouteDeps {
  env?: NodeJS.ProcessEnv
  fetch?: TelegramSenderFetch
  apiBase?: string
}

/** True when this handler owns the request (path matched); the response is written asynchronously. */
export function handleTelegramPairingApi(
  req: IncomingMessage,
  res: ServerResponse,
  codes: PairingCodes,
  deps: PairingRouteDeps = {}
): boolean {
  if (new URL(req.url || '/', 'http://x').pathname !== TELEGRAM_PAIRING_PATH) return false
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    req.resume()
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' })
    return true
  }
  void respond(req, res, codes, deps).catch(() => writeJson(res, 500, { ok: false, error: 'internal_error' }))
  return true
}

async function projectIdFrom(req: IncomingMessage): Promise<string | null> {
  const read = await readCappedRequestBody(req, BODY_LIMIT_BYTES)
  if (!read.ok) return null
  try {
    const body: unknown = JSON.parse(read.body)
    return isRecord(body) ? cleanText(body['projectId'], MAX_PROJECT_ID_CHARS) : null
  } catch {
    return null // malformed JSON is the same client error as a missing id
  }
}

/** Workspace name; unknown id = null. No registered workspace store (tests, headless) -> the id itself. */
function projectNameOf(projectId: string): string | null {
  let ws: { name: string } | null
  try {
    ws = lookupWorkspace(projectId)
  } catch {
    return null // corrupt stored blob: not a project we can safely point a chat at
  }
  if (ws) return ws.name
  return listWorkspaces() === null ? projectId : null
}

async function botUsername(token: string, deps: PairingRouteDeps): Promise<string | null> {
  try {
    const me = await callBotApi({
      method: 'getMe', params: {}, token, apiBase: deps.apiBase,
      fetch: deps.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch),
      signal: new AbortController().signal, timeoutMs: GET_ME_TIMEOUT_MS,
    })
    const name = (me as { username?: unknown } | null)?.username
    return typeof name === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(name) ? name : null
  } catch {
    return null // callBotApi already redacts; the client only needs "unreachable"
  }
}

async function respond(req: IncomingMessage, res: ServerResponse, codes: PairingCodes, deps: PairingRouteDeps): Promise<void> {
  const projectId = await projectIdFrom(req)
  if (projectId === null) return writeJson(res, 400, { ok: false, error: 'invalid_project_id' })
  const projectName = projectNameOf(projectId)
  if (projectName === null) return writeJson(res, 404, { ok: false, error: 'unknown_project' })
  const token = resolveTelegramBotToken(deps.env ?? process.env)
  if (token === undefined) return writeJson(res, 409, { ok: false, error: 'bot_token_missing' })
  const bot = await botUsername(token, deps)
  if (bot === null) return writeJson(res, 502, { ok: false, error: 'unreachable' })
  const { code, expiresAt } = codes.issue({ projectId, projectName })
  writeJson(res, 200, {
    ok: true, bot: `@${bot}`, link: `https://t.me/${bot}?start=${code}`, projectId, projectName, expiresAt,
  })
}
