// `/api/control/mcp/{tools,call}`: the backend of `webterm mcp`. The caller IS the principal its
// credential proves, never one named in the request: a node token proves `node:<id>` (nodeIdForToken);
// a capability token minted for Central's MCP child (mcp.central.ts) proves `central` for one
// conversation. Pure handler + an `IncomingMessage` adapter whose production deps are the process
// singletons, loaded lazily.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CAPABILITY_HEADER, TOKEN_HEADER } from '../auth'
import { headerValue, type ControlHeaders, type ControlResult } from '../control/controlTypes'
import { readControlBody, parseControlBody, isParseFailure, writeControlJson } from '../control/controlHttpIo'
import { nodeIdForToken, nodeTokenFrom } from '../hooksTokens'
import { MCP_CALL_PATH, MCP_PREFIX, MCP_TOOLS_PATH } from './mcp.paths'
import { callCentralTool, centralConversationOf, listCentralTools } from './mcp.central'
import { callTool, listTools, type McpDeps, type McpReceipt } from './mcp.tools'

export interface McpRequest { method: string; path: string; headers: ControlHeaders; body?: unknown }

/** Answers an MCP backend request; null when the path is not this family. */
export async function mcpRoute(req: McpRequest, deps: McpDeps): Promise<ControlResult> {
  if (req.path !== MCP_TOOLS_PATH && req.path !== MCP_CALL_PATH) return null
  const capability = headerValue(req.headers, CAPABILITY_HEADER)
  if (capability) return centralRoute(req, deps, capability)
  const token = headerValue(req.headers, TOKEN_HEADER) ?? nodeTokenFrom((n) => headerValue(req.headers, n))
  const nodeId = token ? nodeIdForToken(token) : undefined
  if (!token || !nodeId) return { status: 401, body: { error: 'unauthorized' } }
  if (req.path === MCP_TOOLS_PATH) {
    return req.method === 'GET' ? { status: 200, body: { tools: listTools(deps) } } : { status: 405, body: { error: 'method_not_allowed' } }
  }
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const call = callArgs(req)
  if (!call) return { status: 400, body: { error: 'name_required' } }
  return { status: 200, body: await callTool(deps, nodeId, token, call.name, call.args) }
}

const callArgs = (req: McpRequest): { name: string; args: Record<string, unknown> } | null => {
  const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown }
  if (typeof body.name !== 'string' || !body.name) return null
  const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {}
  return { name: body.name, args }
}

/** Central principal: the capability record names the conversation; the CA2 guard is mandatory (fail closed). */
async function centralRoute(req: McpRequest, deps: McpDeps, token: string): Promise<ControlResult> {
  const conversationId = centralConversationOf(deps.capability?.(token))
  if (!conversationId) return { status: 401, body: { error: 'unauthorized' } }
  const c = deps.central
  const central = c?.guard ? { db: c.db, registry: c.registry, env: c.env, guard: c.guard } : null
  if (req.path === MCP_TOOLS_PATH) {
    return req.method === 'GET' ? { status: 200, body: { tools: central ? listCentralTools(central, conversationId) : [] } } : { status: 405, body: { error: 'method_not_allowed' } }
  }
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const call = callArgs(req)
  if (!call) return { status: 400, body: { error: 'name_required' } }
  const out: McpReceipt = central
    ? await callCentralTool(central, conversationId, call.name, call.args)
    : { outcome: 'error', detail: 'central_off', next: 'Central is off; only the user can turn it on', evidence: {}, operationId: null, data: null }
  const seq = deps.events?.append({
    kind: 'mcp.call', source: 'mcp', actor: 'central', trust: 'trusted', subject: call.name,
    workspaceId: null, nodeId: null, payload: { tool: call.name, conversationId, outcome: out.outcome, detail: out.detail },
  }).event.seq
  return { status: 200, body: { ...out, evidence: { ...out.evidence, tool: call.name, ...(seq !== undefined ? { mcpSeq: seq } : {}) } } }
}

/** Production deps over the process runtime (ledger, policy, Central registry, browser, board). */
export async function processMcpDeps(): Promise<McpDeps> {
  const [{ db }, { activePolicy }, { activeEventLog }, { activeLedgerRuntime }, { activeCa2 }, { defaultRegistry }, { activeBrowser }, { capabilityStore }, { allows }, { gitDiffRoute }, { GIT_DIFF_PATH }, { DERIVED_FLAGS }] = await Promise.all([
    import('../db'), import('../policy/policy.runtime'), import('../events/eventsRuntime'), import('../ledger/ledgerRuntimeState'),
    import('../central/ca2Active'), import('../central/tools/defaultRegistry'), import('../browser/browser.state'),
    import('../control/mount'), import('../control/capabilities'), import('../gitDiff.route'), import('../gitDiff.types'),
    import('../../shared/featureCapabilities'),
  ])
  const ledger = activeLedgerRuntime()
  const ca2 = activeCa2()
  // Same effective env Central registers with (ca2Boot `effectiveEnv`): derived read/memory flags on.
  const derived = Object.fromEntries(DERIVED_FLAGS.filter((d) => d.needs.length === 1 && d.needs[0] === 'central').map((d) => [d.key, 'on']))
  const browser = activeBrowser()
  return {
    policy: activePolicy(),
    workspaces: () => db.list(),
    central: ledger && ca2 ? { db: ledger.db, registry: defaultRegistry(), env: { ...ca2.env, ...derived }, guard: ca2.guard } : null,
    capability: (token) => capabilityStore.verify(token),
    browser: browser ? (req) => browser.control(req, { verify: (t, now) => capabilityStore.verify(t, now), allows }) : null,
    gitDiff: (q) => gitDiffRoute(GIT_DIFF_PATH, 'GET', q, async () => ''),
    events: activeEventLog(),
  }
}

/** `IncomingMessage` adapter; false = not this family. Mounted before `handleControlHttp` in api.ts. */
export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, url: URL, readBody: () => Promise<string>): Promise<boolean> {
  if (!url.pathname.startsWith(`${MCP_PREFIX}/`)) return false
  const method = (req.method || 'GET').toUpperCase()
  let body: unknown
  if (method === 'POST') {
    const read = await readControlBody(req, readBody)
    if (!read.ok) { writeControlJson(res, read.reason === 'too_large' ? 413 : 400, { error: read.reason === 'too_large' ? 'payload_too_large' : 'invalid_json' }); return true }
    body = parseControlBody(read.raw)
    if (isParseFailure(body)) { writeControlJson(res, 400, { error: 'invalid_json' }); return true }
  }
  const result = await mcpRoute({ method, path: url.pathname, headers: req.headers, ...(body !== undefined ? { body } : {}) }, await processMcpDeps())
  if (!result) return false
  writeControlJson(res, result.status, result.body)
  return true
}
