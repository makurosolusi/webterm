// Handler murni `/api/control/browser/[:nodeId/]:verb` (PLAN b §4.6). Pola control: `{status, body} | null`
// (null = bukan milik handler ini). Dua jalur identitas: capability `browser.*` (Agent Pusat, node wajib di path) atau
// token node sesi agent PTY — target lalu diselesaikan SAAT PANGGILAN dari kabel node itu (`browser.linkedTarget.ts`).
import { BROWSER_CONTROL_PREFIX, BROWSER_VERB_CAP, BlockedError } from '../../shared/browser.contract'
import type { BrowserErrorCode, BrowserVerb } from '../../shared/browser.contract'
import { isSafeNodeId } from '../../shared/workspace'
import { asObject, headerValue } from '../control/controlTypes'
import type { ControlCapabilities, ControlRequest, ControlResult } from '../control/controlTypes'
import { createLogger } from '../logs/logger'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { controlOk } from './browserAgent.wrap'
import { BrowserError } from './browserHost.targets'
import { requesterOf } from './browser.linkedTarget'
import { capabilityHolder } from '../control/controlAuth'
import type { Policy } from '../policy/policy.decide'
import type { Grant } from '../policy/policy.model'
import { activePolicy } from '../policy/policy.runtime'
import type { LinkedTarget } from './browser.linkedTarget'

const log = createLogger('browser.control')
const CAPABILITY_HEADER = 'x-webterm-capability'

export interface BrowserControlDeps {
  capabilities: ControlCapabilities
  verbs: AgentVerbs
  /** Gabungan flag fitur + env + toggle `agentControl` node. */
  agentAllowed(nodeId: string): boolean
  /** Browser yang terhubung kabel dengan node agent `requesterId` (dibaca live dari board). Absen = jalur token node mati. */
  linked?(requesterId: string, wanted?: string): LinkedTarget
  /** Policy seam; absent = the process policy over the ledger (null = ledger off, no rules). */
  policy?: () => Pick<Policy, 'decide'> | null
}

const STATUS_BY_CODE: Record<BrowserErrorCode, number> = {
  lease_agent: 409, lease_human: 409, human_active: 409, stale_ref: 409,
  no_binary: 503, disabled: 403, blocked: 403, not_found: 404, too_large: 413, bad_request: 400, crashed: 502,
}

const fail = (status: number, error: string, extra: object = {}): ControlResult => ({ status, body: { error, ...extra } })

/** Petakan galat verb ke respons; galat tak dikenal dilog (hanya nama, tanpa URL/pesan halaman) dan jadi 500. */
function mapError(err: unknown, nodeId: string): ControlResult {
  if (err instanceof BlockedError) return fail(403, 'blocked', { reason: err.reason, ...(err.hostname ? { hostname: err.hostname } : {}) })
  if (err instanceof BrowserError) return fail(STATUS_BY_CODE[err.code], err.code, err.hostname ? { hostname: err.hostname } : {})
  log.error('browser.control.fail', 'Browser control verb failed', { ids: { nodeId }, status: 500, error: err instanceof Error ? err.name : 'unknown' })
  return fail(500, 'internal')
}

/** Tangani satu request kontrol browser; `null` bila path bukan di bawah prefix browser. */
export async function handleBrowserControl(req: ControlRequest, deps: BrowserControlDeps): Promise<ControlResult> {
  const prefix = `${BROWSER_CONTROL_PREFIX}/`
  if (!req.path.startsWith(prefix)) return null
  const parts = req.path.slice(prefix.length).split('/')
  // `<verb>` saja = target dari kabel; `<nodeId>/<verb>` = target eksplisit.
  const [wanted, verb] = parts.length === 1 ? [undefined, parts[0]] : parts
  if (parts.length > 2 || !verb || !Object.hasOwn(BROWSER_VERB_CAP, verb)) return fail(404, 'not_found')
  if (wanted !== undefined && !isSafeNodeId(wanted)) return fail(400, 'invalid_node_id')
  const v = verb as BrowserVerb
  if (req.method !== 'POST' && !(v === 'status' && req.method === 'GET')) return fail(405, 'method_not_allowed')

  let nodeId: string
  let principal: string
  let cable: Grant[] | undefined
  const token = headerValue(req.headers, CAPABILITY_HEADER)
  if (token) {
    const record = deps.capabilities.verify(token)
    if (!record) return fail(401, 'unauthorized')
    if (wanted === undefined) return fail(400, 'node_required')
    if (!deps.capabilities.allows(record, BROWSER_VERB_CAP[v], `node:${wanted}`)) return fail(403, 'forbidden')
    nodeId = wanted
    principal = capabilityHolder(record)
  } else {
    // Token node sesi agent: hanya browser yang terhubung kabel dengannya (default-deny untuk yang lain).
    const requester = deps.linked && requesterOf(req.headers)
    if (!requester || !deps.linked) return fail(401, 'unauthorized')
    const target = deps.linked(requester, wanted)
    if (!target.ok) return target.result
    nodeId = target.nodeId
    principal = `node:${requester}`
    cable = target.cable
  }
  // Rules on top of the cable/token (PLAN S2): the cable is a live `browser.*` grant, a human rule
  // written later can narrow it (last match wins). Release only hands control back, so it is never gated.
  if (v !== 'release') {
    const d = (deps.policy ?? activePolicy)()?.decide(principal, BROWSER_VERB_CAP[v], { resource: `node:${nodeId}`, ...(cable ? { cable } : {}) })
    if (d && d.effect !== 'allow') {
      return fail(403, d.effect === 'ask' ? 'approval_required' : 'policy_denied', { message: `${d.reason}. Only the user can change this rule; do not retry.` })
    }
  }
  if (v !== 'release' && !deps.agentAllowed(nodeId)) {
    return fail(403, 'disabled', { message: 'Agent control is off for this browser node (toolbar checkbox or Settings). Only the user can turn it on; do not retry.' })
  }

  try {
    const data = await deps.verbs[v](nodeId, asObject(req.body))
    return { status: 200, body: controlOk(data) }
  } catch (err) {
    return mapError(err, nodeId)
  }
}
