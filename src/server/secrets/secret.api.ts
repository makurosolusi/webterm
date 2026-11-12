// `/api/secrets[/:name]`: the UI-only side of the secret broker (Settings › Rules & secrets › Secrets).
//   GET    /api/secrets         names + last used + usage log (never values)
//   PUT    /api/secrets/:name   add or replace a value ({ value }); the answer never echoes it
//   DELETE /api/secrets/:name   remove
// Same gate as policy rules (policy.api.ts): an agent credential or a non-browser caller gets 403.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import type { EventLog } from '../events/eventLog'
import { activeEventLog } from '../events/eventsRuntime'
import { isValidNodeToken } from '../hooksTokens'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { SECRET_NAME_PATTERN } from './secret.capabilities'
import { createBrokerStore, lastUsedByName, SECRET_SUBJECT_PREFIX, usageLog, type BrokerStore } from './secret.store'

export const SECRETS_PATH = '/api/secrets'
export const SECRET_CHANGE_EVENT = 'secret.change'
/** Shorter values would mask unrelated output text (secret.redact.ts). */
export const SECRET_VALUE_MIN = 8
export const SECRET_VALUE_MAX = 32 * 1024
const BODY_MAX_BYTES = 64 * 1024
const USAGE_LIMIT = 100
const NAME_RE = new RegExp(SECRET_NAME_PATTERN)

export interface SecretsApiDeps {
  store: BrokerStore
  db: Database | null
  events: Pick<EventLog, 'append'> | null
  isNodeToken: (token: string) => boolean
}

type Result = { status: number; body: unknown }

/** Handles the secrets routes (caller already matched the path); `body` is the parsed JSON for PUT. */
export function handleSecretsApi(req: IncomingMessage, url: URL, body: unknown, deps: SecretsApiDeps): Result {
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_manage_secrets' : denial } }
  const name = decodeURIComponent(url.pathname.slice(SECRETS_PATH.length + 1))
  const method = req.method ?? 'GET'

  if (!name && method === 'GET') {
    const used = deps.db ? lastUsedByName(deps.db) : new Map<string, number>()
    return { status: 200, body: {
      secrets: deps.store.names().map((n) => ({ name: n, lastUsedAt: used.get(n) ?? null })),
      usage: deps.db ? usageLog(deps.db, USAGE_LIMIT) : null,
    } }
  }
  if (!name || !NAME_RE.test(name)) return { status: name ? 400 : 405, body: { error: name ? 'invalid_name' : 'method_not_allowed' } }
  const change = (op: string): void => {
    deps.events?.append({ kind: SECRET_CHANGE_EVENT, source: 'secrets', actor: 'human-ui', subject: `${SECRET_SUBJECT_PREFIX}${name}`, trust: 'trusted', payload: { op, name } })
  }
  if (method === 'PUT') {
    const value = (body as { value?: unknown } | null)?.value
    if (typeof value !== 'string' || value.trim().length < SECRET_VALUE_MIN || value.length > SECRET_VALUE_MAX) {
      return { status: 400, body: { error: 'invalid_value', min: SECRET_VALUE_MIN, max: SECRET_VALUE_MAX } }
    }
    const existed = deps.store.read(name) !== null
    deps.store.write(name, value.trim())
    change(existed ? 'replace' : 'create')
    return { status: 200, body: { ok: true, name } }
  }
  if (method === 'DELETE') {
    if (deps.store.read(name) === null) return { status: 404, body: { error: 'not_found' } }
    deps.store.remove(name)
    change('delete')
    return { status: 200, body: { ok: true, name } }
  }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** api.ts mount (after the transport gate): false = not ours. */
export async function secretsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== SECRETS_PATH && !url.pathname.startsWith(`${SECRETS_PATH}/`)) return false
  const send = (status: number, payload: unknown): true => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(payload))
    return true
  }
  let body: unknown
  if (req.method === 'PUT') {
    const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
    if (!read.ok) return send(read.reason === 'too_large' ? 413 : 400, { error: read.reason })
    try {
      body = read.body === '' ? {} : JSON.parse(read.body)
    } catch {
      return send(400, { error: 'invalid_json' }) // never echo the body: it holds the value
    }
  }
  const out = handleSecretsApi(req, url, body, {
    store: createBrokerStore(), db: activeLedgerRuntime()?.db ?? null, events: activeEventLog(), isNodeToken: isValidNodeToken,
  })
  return send(out.status, out.body)
}
