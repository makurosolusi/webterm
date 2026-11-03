// Handler murni `/api/control/browser/:nodeId/:verb` (PLAN b §4.6). Pola control: `{status, body} | null`
// (null = bukan milik handler ini). Mount di api.ts dilakukan integrator (WS-08/11), bukan di sini.
import { BROWSER_CONTROL_PREFIX, BROWSER_VERB_CAP, BlockedError } from '../../shared/browser.contract'
import type { BrowserErrorCode, BrowserVerb } from '../../shared/browser.contract'
import { isSafeNodeId } from '../../shared/workspace'
import { asObject, headerValue } from '../control/controlTypes'
import type { ControlCapabilities, ControlRequest, ControlResult } from '../control/controlTypes'
import { createLogger } from '../logs/logger'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { controlOk } from './browserAgent.wrap'
import { BrowserError } from './browserHost.targets'

const log = createLogger('browser.control')
const CAPABILITY_HEADER = 'x-webterm-capability'

export interface BrowserControlDeps {
  capabilities: ControlCapabilities
  verbs: AgentVerbs
  /** Gabungan flag fitur + env + toggle `agentControl` node. */
  agentAllowed(nodeId: string): boolean
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
  const [nodeId, verb] = parts
  if (parts.length !== 2 || !verb || !Object.hasOwn(BROWSER_VERB_CAP, verb)) return fail(404, 'not_found')
  if (!isSafeNodeId(nodeId)) return fail(400, 'invalid_node_id')
  const v = verb as BrowserVerb
  if (req.method !== 'POST' && !(v === 'status' && req.method === 'GET')) return fail(405, 'method_not_allowed')

  const token = headerValue(req.headers, CAPABILITY_HEADER)
  const record = token ? deps.capabilities.verify(token) : undefined
  if (!record) return fail(401, 'unauthorized')
  if (!deps.capabilities.allows(record, BROWSER_VERB_CAP[v], `node:${nodeId}`)) return fail(403, 'forbidden')
  if (v !== 'release' && !deps.agentAllowed(nodeId)) return fail(403, 'disabled')

  try {
    const data = await deps.verbs[v](nodeId, asObject(req.body))
    return { status: 200, body: controlOk(data) }
  } catch (err) {
    return mapError(err, nodeId)
  }
}
