// `/api/control/mcp/{tools,call}`: the backend of `webterm mcp`. Node tokens only: the caller IS the
// node its token proves (nodeIdForToken), never a node named in the request. Pure handler + an
// `IncomingMessage` adapter whose production deps are the process singletons, loaded lazily.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TOKEN_HEADER } from '../auth'
import { headerValue, type ControlHeaders, type ControlResult } from '../control/controlTypes'
import { readControlBody, parseControlBody, isParseFailure, writeControlJson } from '../control/controlHttpIo'
import { NODE_TOKEN_HEADER, nodeIdForToken } from '../hooksTokens'
import { MCP_CALL_PATH, MCP_PREFIX, MCP_TOOLS_PATH } from './mcp.paths'
import { callTool, listTools, type McpDeps } from './mcp.tools'

export interface McpRequest { method: string; path: string; headers: ControlHeaders; body?: unknown }

/** Answers an MCP backend request; null when the path is not this family. */
export async function mcpRoute(req: McpRequest, deps: McpDeps): Promise<ControlResult> {
  if (req.path !== MCP_TOOLS_PATH && req.path !== MCP_CALL_PATH) return null
  const token = headerValue(req.headers, TOKEN_HEADER) ?? headerValue(req.headers, NODE_TOKEN_HEADER)
  const nodeId = token ? nodeIdForToken(token) : undefined
  if (!token || !nodeId) return { status: 401, body: { error: 'unauthorized' } }
  if (req.path === MCP_TOOLS_PATH) {
    return req.method === 'GET' ? { status: 200, body: { tools: listTools(deps) } } : { status: 405, body: { error: 'method_not_allowed' } }
  }
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
  const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown }
  if (typeof body.name !== 'string' || !body.name) return { status: 400, body: { error: 'name_required' } }
  const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {}
  return { status: 200, body: await callTool(deps, nodeId, token, body.name, args) }
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
    central: ledger && ca2 ? { db: ledger.db, registry: defaultRegistry(), env: { ...ca2.env, ...derived } } : null,
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
