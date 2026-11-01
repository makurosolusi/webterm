// Human approval surface. Unlike /api/control/approval/*, this route is authorized by the
// transport token (root/loopback), never by an agent capability: an agent must not approve its
// own irreversible action. It only reads/decides existing approvals; requesting one remains a
// control-plane action.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { activeLedgerRuntime } from './ledger/ledgerRuntime'
import { LedgerError } from './ledger/ledgerModel'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, max = 8 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > max) reject(new Error('body_too_large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

interface Body {
  id?: unknown
  digest?: unknown
  nonce?: unknown
  approve?: unknown
  actor?: unknown
  kind?: unknown
  projectId?: unknown
  request?: unknown
  ttlMs?: unknown
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    throw new LedgerError(`invalid_${field}`)
  }
  return value
}

function challenge(id: string): { id: string; digest: string; nonce: string; expiresAt: number | null; kind: string; projectId: string | null; status: string } | null {
  const rt = activeLedgerRuntime()
  if (!rt) return null
  const row = rt.db
    .query(
      `SELECT a.id, a.kind, a.project_id, a.status, a.expires_at, d.action_digest, d.nonce
       FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?`
    )
    .get(id) as Record<string, unknown> | null
  if (!row) return null
  return {
    id: String(row['id']),
    digest: String(row['action_digest']),
    nonce: String(row['nonce']),
    expiresAt: row['expires_at'] === null ? null : Number(row['expires_at']),
    kind: String(row['kind']),
    projectId: row['project_id'] === null ? null : String(row['project_id']),
    status: String(row['status']),
  }
}

/** Returns true when it handled the request; false lets api.ts continue to 404. */
export async function approvalHumanRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/approvals')) return false
  const rt = activeLedgerRuntime()
  if (!rt) {
    sendJson(res, 503, { error: 'ledger_off' })
    return true
  }
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET' && url.pathname === '/api/approvals/challenge') {
    const id = url.searchParams.get('id') ?? ''
    const result = challenge(id)
    if (!result) {
      sendJson(res, 404, { error: 'approval_not_found' })
      return true
    }
    sendJson(res, 200, result)
    return true
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' })
    return true
  }
  let body: Body
  try {
    body = JSON.parse(await readBody(req)) as Body
  } catch {
    sendJson(res, 400, { error: 'invalid_json' })
    return true
  }
  try {
    if (url.pathname === '/api/approvals/request') {
      const projectId = required(body.projectId, 'projectId')
      const kind = required(body.kind, 'kind')
      const ttl = typeof body.ttlMs === 'number' ? body.ttlMs : undefined
      const created = rt.ledger.approval.requestApproval({
        projectId,
        kind,
        request: body.request ?? null,
        ...(ttl === undefined ? {} : { ttlMs: ttl }),
      })
      sendJson(res, 201, created)
      return true
    }
    const id = required(body.id, 'id')
    if (url.pathname === '/api/approvals/decide') {
      const digest = required(body.digest, 'digest')
      const nonce = required(body.nonce, 'nonce')
      if (typeof body.approve !== 'boolean') throw new LedgerError('invalid_approve')
      const actor = body.actor === undefined ? 'human' : required(body.actor, 'actor')
      const decision = rt.ledger.approval.decideApproval(id, {
        actor,
        approve: body.approve,
        digest,
        nonce,
      })
      sendJson(res, 200, { id: decision.id, status: decision.status })
      return true
    }
    if (url.pathname === '/api/approvals/consume') {
      const digest = required(body.digest, 'digest')
      const ok = rt.ledger.approval.consumeApproval(id, { digest })
      sendJson(res, ok ? 200 : 409, { ok, id })
      return true
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = message.startsWith('invalid_') ? message : 'approval_decision_failed'
    sendJson(res, code === 'approval_decision_failed' ? 409 : 400, { error: code })
    return true
  }
  sendJson(res, 404, { error: 'not_found' })
  return true
}
