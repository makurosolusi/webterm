// `/api/policy/grants[/:id]`: rule amendments from the webterm UI only (K4). The caller's principal is
// derived from its credential (Orca rpc-caller-scope): an agent credential is refused before the
// policy engine sees the request, and anything that is not a same-origin browser page is not `human-ui`.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { readCappedRequestBody } from '../cappedRequestBody'
import { isValidNodeToken } from '../hooksTokens'
import type { Policy } from './policy.decide'
import { activePolicy } from './policy.runtime'
import type { Effect } from './policy.model'

export const POLICY_GRANTS_PATH = '/api/policy/grants'
const LIST_MAX = 500
const BODY_MAX_BYTES = 16 * 1024

export interface PolicyApiDeps {
  policy: Policy
  isNodeToken: (token: string) => boolean
}

type Result = { status: number; body: unknown } | null

/** Handles the grants routes; null when `url` is not one of them. */
export function handlePolicyApi(req: IncomingMessage, url: URL, body: unknown, deps: PolicyApiDeps): Result {
  if (url.pathname !== POLICY_GRANTS_PATH && !url.pathname.startsWith(`${POLICY_GRANTS_PATH}/`)) return null
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_grant' : denial } }
  const id = url.pathname.slice(POLICY_GRANTS_PATH.length + 1)
  const method = req.method ?? 'GET'

  if (!id && method === 'GET') return { status: 200, body: { grants: deps.policy.store.grants().slice(0, LIST_MAX) } }
  if (!id && method === 'POST') {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const res = deps.policy.createGrant('human-ui', {
      subject: b.subject as string, capability: b.capability as string, effect: b.effect as Effect,
      ...(typeof b.scope === 'string' ? { scope: b.scope } : {}),
      ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
      // Passed through as sent: createGrant refuses anything but null or one well-formed workspace id.
      ...(b.workspaceId !== undefined ? { workspaceId: b.workspaceId as string | null } : {}),
    })
    return res.ok ? { status: 201, body: { grant: res.grant } } : { status: res.status, body: { error: res.code } }
  }
  if (id && method === 'DELETE') {
    const res = deps.policy.revokeGrant('human-ui', decodeURIComponent(id))
    return res.ok ? { status: 200, body: { ok: true } } : { status: res.status, body: { error: res.code } }
  }
  return { status: 405, body: { error: 'method_not_allowed' } }
}

/** api.ts mount (runs after the transport gate `allowed()`): reads the body, answers JSON. False = not ours. */
export async function policyRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== POLICY_GRANTS_PATH && !url.pathname.startsWith(`${POLICY_GRANTS_PATH}/`)) return false
  const send = (status: number, body: unknown): true => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
    return true
  }
  const policy = activePolicy()
  if (!policy) return send(503, { error: 'ledger_off' })
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
  const out = handlePolicyApi(req, url, body, { policy, isNodeToken: isValidNodeToken })
  return out ? send(out.status, out.body) : false
}
