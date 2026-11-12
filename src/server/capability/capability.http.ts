// `/api/tools`: the HTTP projection of the capability registry that the `webterm` CLI talks to (plan F2-b).
//   GET  /api/tools            agent-context for the caller (Orca `agent-context --json`, src/cli/agent-context.ts:27-52)
//   GET  /api/tools/whats-new  registry diff since the version this caller last saw (`?since=` overrides)
//   POST /api/tools/:name      run one capability as the caller, gated by policy decide(); answers a receipt
// `Accept: text/plain` turns the two GETs into the human-readable form the CLI prints without --json.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Workspace } from '../../shared/workspace'
import { readCappedBody } from '../channels/channelHttp'
import { boardOf, execute, judge, nodeOf, principalOf, receipt, type Args, type ToolsDeps } from '../cli/cli.exec'
import { cliStateDir, TOOLS_PATH } from '../cli/cli.launcher'
import { buildAgentContext, diffRegistry, formatAgentContext, formatDiff, snapshotOf, TOOL_INDEX } from '../cli/cli.registry'
import { createSeenStore, type SeenStore } from '../cli/cli.seen'
import { firstHeader } from '../httpHeaders'
import { cableGrants } from '../policy/policy.cable'
import { wildcardMatch, type Principal } from '../policy/policy.model'
import { askByDefault, listByDefault } from '../secrets/secret.broker'
import { isSecretCapability } from '../secrets/secret.capabilities'
import { SECRET_SUBJECT_PREFIX } from '../secrets/secret.store'
import { callFingerprint, createMemoryReceiptLog, runOnce, type Receipt } from './capability.receipt'
import { AGENT_REPORT_CAPABILITY, reportByDefault } from './report.capabilities'

export type { ToolsDeps }
export const TOOLS_BODY_MAX_BYTES = 256 * 1024
const VERSION_RE = /^[0-9a-f]{12}$/

const sharedReceipts = createMemoryReceiptLog()
let sharedSeen: SeenStore | undefined
const seenOf = (deps: ToolsDeps): SeenStore => deps.seen ?? (sharedSeen ??= createSeenStore(cliStateDir()))

type Reply = { status: number; body: unknown; text?: string }

const httpStatus = (r: Receipt): number => {
  if (r.outcome === 'ok') return 200
  if (r.outcome === 'denied') return 403
  const s = r.evidence.status
  return typeof s === 'number' && s >= 400 ? s : 400
}

/**
 * The broker's own defaults (list open, run asks a node until a human grant) with its resource shape
 * `secret:<NAME>:<argv>` wildcarded, so a broad human rule (`secret:*`) shows here too.
 */
const secretDefaults = (principal: Principal, capName: string) => capName === 'secret.list'
  ? { resource: undefined, cable: listByDefault(principal) }
  : { resource: `${SECRET_SUBJECT_PREFIX}*:*`, cable: askByDefault(principal) }

/** Agent-context for `principal`; also records that this caller has now seen this registry version. */
function agentContext(deps: ToolsDeps, principal: Principal, board: readonly Workspace[]) {
  const nodeId = nodeOf(principal)
  const cable = nodeId ? cableGrants(board, nodeId) : undefined
  // Discovery evaluates without recording: no policy.decision event per capability per call.
  const ctx = buildAgentContext(principal, (cap) => {
    if (isSecretCapability(cap.name)) {
      const s = secretDefaults(principal, cap.name)
      return judge(deps, principal, cap, s.resource, s.cable, false).effect
    }
    if (cap.name === AGENT_REPORT_CAPABILITY) return judge(deps, principal, cap, undefined, reportByDefault(principal), false).effect
    const cabled = cable?.find((g) => wildcardMatch(g.capability, cap.name))?.scope
    return judge(deps, principal, cap, cabled, cable, false).effect
  })
  const seen = seenOf(deps)
  seen.saveSnapshot(snapshotOf())
  seen.markSeen(principal, ctx.registryVersion)
  return ctx
}

function whatsNew(deps: ToolsDeps, principal: Principal, sinceParam: string | null) {
  const seen = seenOf(deps)
  const current = snapshotOf()
  seen.saveSnapshot(current)
  const since = sinceParam ?? seen.lastSeen(principal)
  const base = since ? seen.snapshot(since) : null
  const diff = diffRegistry(base, current)
  seen.markSeen(principal, current.version)
  return { since, version: current.version, baseline: base ? 'known' : since ? 'unknown' : 'none', ...diff }
}

async function runCapability(req: IncomingMessage, url: URL, deps: ToolsDeps, principal: Principal): Promise<Reply> {
  const name = url.pathname.slice(TOOLS_PATH.length + 1)
  const cap = TOOL_INDEX.get(name)
  if (!cap) return { status: 404, body: { receipt: receipt('error', 'unknown_capability', { name: name.slice(0, 100) }, 'webterm agent-context lists the capabilities that exist') } }
  const read = await readCappedBody(req, TOOLS_BODY_MAX_BYTES)
  if (!read.ok) return { status: read.reason === 'too_large' ? 413 : 400, body: { receipt: receipt('error', read.reason === 'too_large' ? 'payload_too_large' : 'invalid_json') } }
  let args: unknown
  try {
    args = read.body.trim() === '' ? {} : JSON.parse(read.body)
  } catch {
    args = null // reported just below, with the same answer as a non-object body
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { status: 400, body: { receipt: receipt('error', 'invalid_json', {}, 'pass a JSON object: --json \'{"key":"value"}\'') } }
  }
  const operationId = url.searchParams.get('operationId') ?? undefined
  let data: unknown
  // The principal is part of the fingerprint: one caller's operationId never replays another's receipt.
  const r = await runOnce(deps.receipts ?? sharedReceipts, operationId, callFingerprint(`${principal}\0${name}`, args), async () => {
    const run = await execute(deps, cap, args as Args, principal, req.headers)
    data = run.data
    return run.receipt
  })
  return { status: httpStatus(r), body: { receipt: r, ...(data !== undefined ? { data } : {}) } }
}

async function handle(req: IncomingMessage, url: URL, deps: ToolsDeps): Promise<Reply> {
  const path = url.pathname
  const method = (req.method || 'GET').toUpperCase()
  const principal = principalOf(req.headers)
  const text = /text\/plain/.test(firstHeader(req.headers.accept) ?? '')
  if (path === TOOLS_PATH && method === 'GET') {
    const ctx = agentContext(deps, principal, nodeOf(principal) ? await boardOf(deps) : [])
    return { status: 200, body: ctx, ...(text ? { text: formatAgentContext(ctx) } : {}) }
  }
  if (path === `${TOOLS_PATH}/whats-new` && method === 'GET') {
    const since = url.searchParams.get('since')
    if (since !== null && !VERSION_RE.test(since)) return { status: 400, body: { error: 'invalid_version' } }
    const d = whatsNew(deps, principal, since)
    return { status: 200, body: d, ...(text ? { text: formatDiff(d.since, d.version, d) } : {}) }
  }
  if (path === TOOLS_PATH || method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  return runCapability(req, url, deps, principal)
}

/** Route family entry for `api.ts`; false = not `/api/tools`, keep falling through. */
export async function toolsRoute(req: IncomingMessage, res: ServerResponse, url: URL, deps: ToolsDeps): Promise<boolean> {
  if (url.pathname !== TOOLS_PATH && !url.pathname.startsWith(`${TOOLS_PATH}/`)) return false
  const out = await handle(req, url, deps)
  res.statusCode = out.status
  if (out.text !== undefined) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(`${out.text}\n`)
    return true
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(out.body))
  return true
}
