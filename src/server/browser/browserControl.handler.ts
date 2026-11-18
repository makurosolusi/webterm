// Handler murni `/api/control/browser/[:nodeId/]:verb` (PLAN b §4.6). Pola control: `{status, body} | null`
// (null = bukan milik handler ini). Dua jalur identitas: capability `browser.*` (Agent Pusat, node wajib di path) atau
// token node sesi agent PTY — target lalu diselesaikan SAAT PANGGILAN dari kabel node itu (`browser.linkedTarget.ts`).
import { BROWSER_CONTROL_PREFIX, BROWSER_PROFILES_VERB, BROWSER_VERB_CAP, BlockedError } from '../../shared/browser.contract'
import type { BrowserErrorCode, BrowserVerb } from '../../shared/browser.contract'
import { isSafeNodeId } from '../../shared/workspace'
import { asObject, headerValue } from '../control/controlTypes'
import type { ControlCapabilities, ControlRequest, ControlResult } from '../control/controlTypes'
import { createLogger } from '../logs/logger'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { controlOk } from './browserAgent.wrap'
import { BrowserError } from './browserHost.targets'
import { CdpTimeoutError } from './cdp.client'
import { requesterOf } from './browser.linkedTarget'
import { capabilityHolder } from '../control/controlAuth'
import type { Policy } from '../policy/policy.decide'
import type { Grant } from '../policy/policy.model'
import { activePolicy } from '../policy/policy.runtime'
import type { LinkedTarget } from './browser.linkedTarget'
import { parseBrowserUrl } from '../../shared/browser.url'
import { openAgentBrowser, openedNote } from './browser.agentOpen'
import type { AgentOpenDeps } from './browser.agentOpen'
import { presetBrowserDenial } from './browser.presetLock'
import { AgentTabError } from './browser.agentTabs.verbs'

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
  /** `open` (and `navigate` with no cabled browser) on the node-token path; absent = 503 `open_unavailable`. */
  open?: AgentOpenDeps
  /** Stored `preset` of a canvas node (read from the DB-backed board, never from the client); set = read-only public-web lock. */
  presetOf?(nodeId: string): string | undefined
}

type NodeVerb = Exclude<BrowserVerb, 'open'>
/** What an agent-made browser node adds to the reply, success or error, so the agent can target it. */
type Opened = { nodeId: string; url: string; note: string }

const STATUS_BY_CODE: Record<BrowserErrorCode, number> = {
  lease_agent: 409, human_active: 409, stale_ref: 409,
  no_binary: 503, disabled: 403, blocked: 403, not_found: 404, too_large: 413, bad_request: 400, crashed: 502,
  launch_failed: 503, max_live: 409, human_verification_required: 409,
}

const HUMAN_ACTIVE_MESSAGE = 'The user is using this browser right now. Retry shortly; after a couple of tries, tell the user.'

const fail = (status: number, error: string, extra: object = {}): ControlResult => ({ status, body: { error, ...extra } })

/** Petakan galat verb ke respons; galat tak dikenal dilog (hanya nama, tanpa URL/pesan halaman) dan jadi 500. */
function mapError(err: unknown, nodeId: string): ControlResult {
  if (err instanceof BlockedError) return fail(403, 'blocked', { reason: err.reason, ...(err.hostname ? { hostname: err.hostname } : {}) })
  if (err instanceof AgentTabError) return fail(err.status, err.wire, { message: err.message, next: err.next })
  if (err instanceof BrowserError) return fail(STATUS_BY_CODE[err.code], err.code, { ...(err.hostname ? { hostname: err.hostname } : {}), ...(err.code === 'human_active' ? { message: HUMAN_ACTIVE_MESSAGE } : {}) })
  // Page did not answer in time (e.g. a stalled first navigation): tell the agent to retry, not "internal".
  if (err instanceof CdpTimeoutError) return fail(504, 'timeout', { message: 'The page did not respond in time. Retry once; if it repeats, tell the user.' })
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
  if (parts.length === 1 && verb === BROWSER_PROFILES_VERB) return profilesVerb(req, deps)
  if (parts.length > 2 || !verb || !Object.hasOwn(BROWSER_VERB_CAP, verb)) return fail(404, 'not_found')
  if (wanted !== undefined && !isSafeNodeId(wanted)) return fail(400, 'invalid_node_id')
  const asked = verb as BrowserVerb
  if (req.method !== 'POST' && !(asked === 'status' && req.method === 'GET')) return fail(405, 'method_not_allowed')

  const token = headerValue(req.headers, CAPABILITY_HEADER)
  if (token) {
    const record = deps.capabilities.verify(token)
    if (!record) return fail(401, 'unauthorized')
    if (asked === 'open') return fail(400, 'agent_node_only', { message: '`open` adds a browser node beside the calling canvas agent; it needs a node token, not a capability.' })
    if (wanted === undefined) return fail(400, 'node_required')
    if (!deps.capabilities.allows(record, BROWSER_VERB_CAP[asked], `node:${wanted}`)) return fail(403, 'forbidden')
    return runVerb(deps, asked, wanted, capabilityHolder(record), undefined, req.body)
  }
  // Token node sesi agent: hanya browser yang terhubung kabel dengannya (default-deny untuk yang lain).
  const linked = deps.linked
  const requester = linked && requesterOf(req.headers)
  if (!requester || !linked) return fail(401, 'unauthorized')
  const principal = `node:${requester}`
  if (deps.presetOf?.(requester)) {
    const denied = presetBrowserDenial(asked, wanted, asObject(req.body).url, asObject(req.body).profile, asObject(req.body).tab)
    if (denied) return denied
  }
  if (asked !== 'open') {
    const target = linked(requester, wanted)
    const none = !target.ok && asked === 'navigate' && deps.open !== undefined && (target.result.body as { error?: string }).error === 'no_linked_browser'
    if (!none) return target.ok ? runVerb(deps, asked, target.nodeId, principal, target.cable, req.body) : target.result
  } else if (wanted !== undefined) {
    return fail(400, 'bad_request', { message: '`open` makes a new browser node; do not pass --node.' })
  }
  return openThenNavigate(req.body, requester, { ...deps, linked }, asked === 'navigate')
}

/** `webterm browser profiles`: the profile names the calling canvas agent may pass to `open --profile`. Read-only, node token only; a locked preset never gets it. */
async function profilesVerb(req: ControlRequest, deps: BrowserControlDeps): Promise<ControlResult> {
  if (req.method !== 'GET') return fail(405, 'method_not_allowed')
  const requester = deps.linked && requesterOf(req.headers)
  if (!requester) return fail(401, 'unauthorized')
  if (deps.presetOf?.(requester)) return fail(403, 'verb_not_allowed_for_preset', { message: 'This agent may only open, navigate to and read public web pages.' })
  const profiles = deps.open?.profiles
  if (!profiles) return fail(503, 'open_unavailable', { message: 'Browser profiles are not available on this server.' })
  const ws = (await deps.open!.canvas()).workspaceOfNode(requester)
  if (!ws) return fail(404, 'not_on_board', { message: 'This session is not a node on any webterm board.' })
  const list = profiles.list(ws.id).map((p) => ({ name: p.name, color: p.color, live: p.live }))
  return { status: 200, body: controlOk({ profiles: list, note: 'Open a browser on one with `webterm browser open --profile <name> [url]`; no --profile = this board\'s Default.' }) }
}

/** `open`, or `navigate` with no cabled browser: add a cabled browser node, then navigate it through the normal gates. */
async function openThenNavigate(body: unknown, requester: string, deps: BrowserControlDeps & Required<Pick<BrowserControlDeps, 'linked'>>, needUrl: boolean): Promise<ControlResult> {
  const raw = asObject(body).url
  const profile = asObject(body).profile
  if (profile !== undefined && (typeof profile !== 'string' || profile.trim() === '')) return fail(400, 'bad_request', { message: 'profile must be a profile name or id.' })
  const url = raw === undefined && !needUrl ? undefined : parseBrowserUrl(raw)
  if (url && !url.ok) return fail(400, 'bad_request', { message: 'url must be an absolute http or https URL.' })
  if (!deps.open) return fail(503, 'open_unavailable', { message: 'This server cannot open browser nodes for agents. Ask the user to add one and cable it to this node.' })
  let made: Awaited<ReturnType<typeof openAgentBrowser>>
  try {
    made = await openAgentBrowser(deps.open, requester, deps.agentAllowed, undefined, profile)
  } catch (err) {
    return mapError(err, requester)
  }
  if (!made.ok) {
    if ('result' in made) return made.result
    return withOpened(mapError(made.startError, made.nodeId), { nodeId: made.nodeId, url: url?.url ?? '', note: openedNote(made.nodeId, false) })
  }
  const opened = { nodeId: made.nodeId, url: url?.url ?? made.url, note: openedNote(made.nodeId, true, 'profile' in made ? made.profile : undefined) }
  if (!url) return { status: 200, body: controlOk(opened) }
  const target = deps.linked(requester, made.nodeId)
  if (!target.ok) return withOpened(target.result, opened)
  return withOpened(await runVerb(deps, 'navigate', made.nodeId, `node:${requester}`, target.cable, { url: url.url }), opened)
}

function withOpened(result: ControlResult, opened: Opened): ControlResult {
  if (!result) return result
  const body = asObject(result.body)
  if (result.status === 200) return { ...result, body: { ...body, data: { ...asObject(body.data), ...opened } } }
  return { ...result, body: { ...body, ...opened } }
}

/** Policy, the agent-control switch, then the verb itself on an existing browser node. */
async function runVerb(deps: BrowserControlDeps, v: NodeVerb, nodeId: string, principal: string, cable: Grant[] | undefined, body: unknown): Promise<ControlResult> {
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
    const data = await deps.verbs[v](nodeId, asObject(body))
    return { status: 200, body: controlOk(data) }
  } catch (err) {
    return mapError(err, nodeId)
  }
}
