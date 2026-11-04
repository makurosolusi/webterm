// Runs one registry capability for a PROVEN caller (plan F2-b, `POST /api/tools/:name`). Generic: the
// capability's `route` binding is called in-process through the API router, so each capability keeps
// its one handler. Policy `decide()` is asked first; control verbs then get a one-shot capability token
// minted FOR that caller (`mintedBy` = principal), so the control router re-checks the very same
// principal (`controlAuth.capabilityHolder`) and the token is revoked as soon as the call returns.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { BROWSER_CONTROL_PREFIX } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { CAPABILITY_HEADER, TOKEN_HEADER } from '../auth'
import { requesterOf, resolveLinkedBrowser } from '../browser/browser.linkedTarget'
import type { CapabilitySpec } from '../capability/capability.define'
import type { Receipt, ReceiptLog } from '../capability/capability.receipt'
import { checkSchema } from '../capability/capability.schema'
import { CAPABILITY_VERBS, type CapabilityStore, type CapabilityVerb } from '../control/capabilities'
import { capabilityStore } from '../control/mount'
import { NODE_TOKEN_HEADER } from '../hooksTokens'
import { firstHeader } from '../httpHeaders'
import { cableGrants } from '../policy/policy.cable'
import type { Policy } from '../policy/policy.decide'
import type { Decision, Grant, Principal } from '../policy/policy.model'
import { activePolicy } from '../policy/policy.runtime'
import type { SeenStore } from './cli.seen'

/** One-shot capability lifetime: long enough for one in-process call; revoked right after it. */
const ONE_SHOT_TTL_MS = 60_000
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/
const DENY_NEXT = 'Only the user can change this rule; do not retry. Ask your user.'

export interface ToolsDeps {
  /** The API router (`api.ts` `route`); a capability's route binding is dispatched through it. */
  dispatch(req: IncomingMessage, res: ServerResponse): Promise<void>
  policy?: () => Pick<Policy, 'decide'> | null
  workspaces?: () => readonly Workspace[] | Promise<readonly Workspace[]>
  capabilities?: Pick<CapabilityStore, 'mint' | 'revoke'>
  receipts?: ReceiptLog
  seen?: SeenStore
}

export type Args = Record<string, unknown>

/**
 * Proven caller: a node token (the agent's own header file) = `node:<id>`. Anything else reached the
 * route through the root gate in index.ts (root token or tokenless loopback), so it is the human.
 */
export function principalOf(headers: IncomingMessage['headers']): Principal {
  const node = requesterOf(headers)
  return node ? `node:${node}` : 'human-ui'
}

export const nodeOf = (p: Principal): string | null => (p.startsWith('node:') ? p.slice('node:'.length) : null)

function resourceOf(cap: CapabilitySpec, args: Args): string | undefined {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  if (cap.scope === 'node') { const n = str(args.nodeId); return n && `node:${n}` }
  if (cap.scope === 'project') { const p = str(args.projectId) ?? str(args.root); return p && `project:${p}` }
  return undefined
}

export function receipt(outcome: Receipt['outcome'], detail: string, evidence: Record<string, unknown> = {}, next: string | null = null): Receipt {
  return { outcome, detail, next, evidence, operationId: null }
}

export async function boardOf(deps: ToolsDeps): Promise<readonly Workspace[]> {
  if (deps.workspaces) return deps.workspaces()
  const { db } = await import('../db') // lazy: bun:sqlite stays out of vitest imports
  return db.list()
}

/** Policy answer for `principal`. Ledger off = no rules: fail closed for agents, the human keeps pre-policy behaviour. */
export function judge(deps: ToolsDeps, principal: Principal, cap: CapabilitySpec, resource: string | undefined, cable?: readonly Grant[]): Decision {
  const policy = (deps.policy ?? activePolicy)()
  if (!policy) return principal === 'human-ui' ? { effect: 'allow', reason: 'no policy (ledger off)' } : { effect: 'deny', reason: 'no policy (ledger off): agents are denied' }
  return policy.decide(principal, cap.name, { ...(resource ? { resource } : {}), ...(cap.destructive ? { destructive: true } : {}), ...(cable ? { cable } : {}) })
}

/** Calls one route of the API router in-process and collects its answer. */
async function callRoute(dispatch: ToolsDeps['dispatch'], method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: unknown }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  const sized = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
  Object.assign(req, { method, url, headers: { host: '127.0.0.1', ...headers, ...sized } })
  const chunks: Buffer[] = []
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false,
    setHeader: () => res, getHeader: () => undefined, writeHead: (status: number) => { res.statusCode = status; return res },
    write: (c: string | Buffer) => { chunks.push(Buffer.from(c)); return true },
    end: (c?: string | Buffer) => { if (c) chunks.push(Buffer.from(c)); res.writableEnded = true; return res },
  }
  await dispatch(req, res as unknown as ServerResponse)
  if (!res.writableEnded) return { status: 502, body: { error: 'no_response' } }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return { status: res.statusCode, body: raw === '' ? null : JSON.parse(raw) }
  } catch {
    return { status: res.statusCode, body: raw } // a non-JSON answer is passed through as text
  }
}

/** Fills `:param` segments from `args`; the rest becomes the query (GET) or the JSON body (POST). */
function bind(route: NonNullable<CapabilitySpec['route']>, args: Args): { url: string; body?: string } | { missing: string } {
  const used = new Set<string>()
  let missing: string | undefined
  const path = route.path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
    used.add(k)
    const v = args[k]
    if (typeof v !== 'string' || v === '') missing ??= k
    return encodeURIComponent(typeof v === 'string' ? v : '')
  })
  if (missing) return { missing }
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)))
  if (route.method === 'POST') return { url: path, body: JSON.stringify(rest) }
  const q = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString()
  return { url: q ? `${path}?${q}` : path }
}

/** Executes `cap` for `principal`; a caller mistake is an error receipt, never a throw. */
export async function execute(deps: ToolsDeps, cap: CapabilitySpec, input: Args, principal: Principal, headers: IncomingMessage['headers']): Promise<{ receipt: Receipt; data?: unknown }> {
  const problem = checkSchema(cap.input, input)
  if (problem) return { receipt: receipt('error', 'invalid_shape', { problem }, 'webterm agent-context --json shows the exact input schema') }
  const route = cap.route as NonNullable<CapabilitySpec['route']>
  const browser = route.path.startsWith(BROWSER_CONTROL_PREFIX)
  const nodeId = nodeOf(principal)
  let args = input
  let cable: Grant[] | undefined
  if (nodeId) {
    const board = await boardOf(deps)
    cable = cableGrants(board, nodeId)
    // One cabled browser = used automatically, like `webterm browser` (browser.linkedTarget.ts).
    if (browser && args.nodeId === undefined) {
      const target = resolveLinkedBrowser([...board], nodeId)
      if (!target.ok) return { receipt: receipt('error', String((target.result.body as { error: string }).error)), data: target.result.body }
      args = { ...args, nodeId: target.nodeId }
    }
  }
  const resource = resourceOf(cap, args)
  const d = judge(deps, principal, cap, resource, cable)
  if (d.effect !== 'allow') {
    return { receipt: receipt('denied', d.effect === 'ask' ? 'approval_required' : 'policy_denied', { reason: d.reason, ...(d.ruleId ? { ruleId: d.ruleId } : {}) }, DENY_NEXT) }
  }
  const call = bind(route, args)
  if ('missing' in call) return { receipt: receipt('error', 'invalid_shape', { problem: `$.${call.missing}: required` }) }

  const caps = deps.capabilities ?? capabilityStore
  const fwd: Record<string, string> = {}
  let minted: string | undefined
  if (browser && nodeId) {
    // The browser route proves the node itself and resolves its cables: forward the caller's own token.
    for (const h of [TOKEN_HEADER, NODE_TOKEN_HEADER]) { const v = firstHeader(headers[h]); if (v) fwd[h] = v }
  } else if (CAPABILITY_VERBS.includes(cap.name as CapabilityVerb)) {
    const scope = resource ?? (cap.name === 'node.read' ? '*' : undefined)
    if (!scope) return { receipt: receipt('error', 'invalid_shape', { problem: 'a resource id (nodeId/projectId) is required' }) }
    minted = caps.mint({ verb: cap.name as CapabilityVerb, resource: scope, mintedBy: principal, ttlMs: ONE_SHOT_TTL_MS })
    fwd[CAPABILITY_HEADER] = minted
  }
  try {
    const out = await callRoute(deps.dispatch, route.method, call.url, fwd, call.body)
    const evidence = { status: out.status, ...(d.ruleId ? { ruleId: d.ruleId } : {}) }
    if (out.status < 400) return { receipt: receipt('ok', 'ok', evidence), data: out.body }
    const code = (out.body as { error?: unknown } | null)?.error
    const detail = typeof code === 'string' && DETAIL_RE.test(code) ? code : `http_${out.status}`
    return { receipt: receipt(out.status === 401 || out.status === 403 ? 'denied' : 'error', detail, evidence), data: out.body }
  } finally {
    if (minted) caps.revoke(minted)
  }
}
