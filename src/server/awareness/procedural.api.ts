// `/api/awareness/procedural[/:id[/confirm]]`: Settings › Memory. UI-only, the
// same gate as `/api/policy/grants` (policy.api.ts, Orca rpc-caller-scope): an agent credential is
// refused before any memory code runs, and only a same-origin webterm page becomes `human-ui`.
//   GET    list            POST {text}  add verified      POST /:id/confirm  suggestion → verified
//   DELETE /:id            forget (quarantine; history kept)
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from 'bun:sqlite'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { isValidNodeToken } from '../hooksTokens'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { MemoryAuthorityError, MemoryRejectedError } from '../memory/memoryModel'
import { addProcedural, confirmProcedural, forgetProcedural, HUMAN_UI, listProcedural } from './proceduralMemory'

export const PROCEDURAL_PATH = '/api/awareness/procedural'
const BODY_MAX_BYTES = 4 * 1024

type Result = { status: number; body: unknown } | null
const ours = (p: string): boolean => p === PROCEDURAL_PATH || p.startsWith(`${PROCEDURAL_PATH}/`)

/** Handles the routes; null when `url` is not one of them. */
export function handleProceduralApi(req: IncomingMessage, url: URL, body: unknown, db: Database, isNodeToken: (t: string) => boolean): Result {
  if (!ours(url.pathname)) return null
  const denial = uiOnlyDenial(req, url, isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_remember' : denial } }
  const [rawId = '', action = ''] = url.pathname.slice(PROCEDURAL_PATH.length + 1).split('/')
  const method = req.method ?? 'GET'
  try {
    const id = decodeURIComponent(rawId)
    if (!id && method === 'GET') return { status: 200, body: { facts: listProcedural(db) } }
    if (!id && method === 'POST') return { status: 201, body: { fact: addProcedural(db, HUMAN_UI, (body as { text?: unknown } | null)?.text) } }
    if (id && action === 'confirm' && method === 'POST') return { status: 200, body: { fact: confirmProcedural(db, HUMAN_UI, id) } }
    if (id && !action && method === 'DELETE') { forgetProcedural(db, HUMAN_UI, id); return { status: 200, body: { ok: true } } }
    return { status: 405, body: { error: 'method_not_allowed' } }
  } catch (err) {
    if (err instanceof MemoryRejectedError) return { status: err.code === 'not_found' ? 404 : 400, body: { error: err.code } }
    if (err instanceof MemoryAuthorityError) return { status: 403, body: { error: 'forbidden' } }
    if (err instanceof URIError) return { status: 400, body: { error: 'invalid_id' } }
    throw err
  }
}

/** api.ts mount (after the transport gate `allowed()`): reads the body, answers JSON. False = not ours. */
export async function proceduralRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!ours(url.pathname)) return false
  const send = (status: number, body: unknown): true => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
    return true
  }
  const db = activeLedgerRuntime()?.db
  if (!db) return send(503, { error: 'ledger_off' })
  let body: unknown
  if (req.method === 'POST') {
    const read = await readCappedRequestBody(req, BODY_MAX_BYTES)
    if (!read.ok) return send(read.reason === 'too_large' ? 413 : 400, { error: read.reason })
    try {
      body = read.body === '' ? {} : JSON.parse(read.body)
    } catch {
      return send(400, { error: 'invalid_json' })
    }
  }
  const out = handleProceduralApi(req, url, body, db, isValidNodeToken)
  return out ? send(out.status, out.body) : false
}
