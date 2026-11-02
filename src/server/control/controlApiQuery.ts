// Read-only/mint `/api/control/*` routes: nodes, plan, token. Split out of `controlApi.ts`.
import { tokensMatch } from '../auth'
import { CAPABILITY_VERBS, isValidResource, type CapabilityVerb } from './capabilities'
import { authenticate, badRequest, forbidden } from './controlAuth'
import { asObject, headerValue, type ControlDeps, type ControlRequest, type ControlResult } from './controlTypes'

export function nodesRoute(req: ControlRequest, deps: ControlDeps, now: number): ControlResult {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth.failure
  const record = auth.record
  const all = deps.sessions.list()
  // Cek grant atas resource-nya sendiri dulu: tanpa ini, grant `node.spawn` untuk satu node
  // lolos hanya karena daftar sesi kebetulan kosong (tidak ada node untuk difilter).
  if (!deps.capabilities.allows(record, 'node.read', record.resource)) return forbidden.failure
  if (record.resource === '*') return { status: 200, body: all }
  // Grant selain `*` harus menunjuk node; `workspace:`/`project:` tidak memberi daftar node.
  if (!record.resource.startsWith('node:')) return forbidden.failure
  const visible = all.filter((s) => deps.capabilities.allows(record, 'node.read', `node:${s.id}`))
  return { status: 200, body: visible }
}

export function planRoute(req: ControlRequest, deps: ControlDeps, now: number): ControlResult {
  const auth = authenticate(req, deps, now)
  if ('failure' in auth) return auth.failure
  if (!deps.capabilities.allows(auth.record, 'plan.read', auth.record.resource)) return forbidden.failure
  return { status: 501, body: { error: 'plan_not_available' } }
}

/** Mint hanya untuk root eksplisit: flag fitur + header token root yang cocok. Selain itu route
 *  ini tidak ada (404) atau tertutup (403), bukan 401 — ia bukan jalur kapabilitas node.
 *  Perbandingan memakai `tokensMatch` (constant-time), bukan `!==`. */
export function tokenRoute(req: ControlRequest, deps: ControlDeps): ControlResult {
  if (!deps.allowTokenMint || !deps.rootToken || !deps.capabilities.mint) {
    return { status: 404, body: { error: 'not_found' } }
  }
  if (!tokensMatch(deps.rootToken, headerValue(req.headers, 'x-webterm-token'))) {
    return { status: 403, body: { error: 'forbidden' } }
  }
  const body = asObject(req.body)
  const verb = body.verb
  if (typeof verb !== 'string' || !CAPABILITY_VERBS.includes(verb as CapabilityVerb)) {
    return badRequest('invalid_verb')
  }
  const resource = body.resource
  if (typeof resource !== 'string' || !isValidResource(resource)) return badRequest('invalid_resource')
  if (resource === '*' && verb !== 'node.read') return badRequest('invalid_resource')
  let ttlMs: number | undefined
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
      return badRequest('invalid_ttl')
    }
    ttlMs = body.ttlMs
  }
  try {
    const minted = deps.capabilities.mint({ verb: verb as CapabilityVerb, resource, ttlMs })
    return { status: 201, body: { token: minted.token, expiresAt: minted.expiresAt } }
  } catch {
    return badRequest('invalid_mint')
  }
}
