// HTTP for MCP Apps (`ui://` views in an App node).
//   POST /api/control/mcpapps            agent, node token: publish the `resources/read` content of a
//        {resource, toolInput?, toolResult?}  ui:// resource from its own MCP session -> 201 {appId}
//   POST /api/mcpapps/claim {nodeIds}    UI: unplaced apps of these nodes -> {apps:[{id, ownerNodeId, uri}]}
//   GET  /api/mcpapps/:id                UI: the view (CSP already applied) + tool input/result
//   POST /api/mcpapps/:id/call {name, arguments}  UI: the view's tools/call -> CallToolResult (policy-gated)
// The publish path sits under /api/control/ because that is the family the auth gate already opens
// to node tokens (as mcp.paths.ts does); everything else is UI-only (`uiOnlyDenial`).
import type { IncomingMessage } from 'node:http'
import { uiOnlyDenial } from '../approvalAuth'
import { TOKEN_HEADER } from '../auth'
import { BodyReadError } from '../cappedRequestBody'
import { headerValue } from '../control/controlTypes'
import type { McpDeps } from '../mcp/mcp.tools'
import { nodeTokenFrom } from '../hooksTokens'
import { callAppTool } from './mcpApp.call'
import { buildAppCsp, withCspMeta } from './mcpApp.csp'
import { publishApp } from './mcpApp.publish'
import type { McpAppStore } from './mcpApp.store'

export const MCP_APPS_PATH = '/api/mcpapps'
export const MCP_APPS_PUBLISH_PATH = '/api/control/mcpapps'
/** Room for the largest view (MCP_APP_HTML_MAX_CHARS) plus its tool input/result. */
export const MCP_APPS_BODY_MAX_BYTES = 4 * 1024 * 1024
const CLAIM_NODES_MAX = 500

export interface McpAppsDeps {
  store: McpAppStore
  nodeIdForToken(token: string): string | undefined
  isNodeToken(token: string): boolean
  /** The MCP tool path deps (mcp.route `processMcpDeps`): policy + events for publish, the executor for calls. */
  mcp(): Promise<McpDeps>
  now(): number
}

type Result = { status: number; body?: unknown } | null

export const isMcpAppsPath = (p: string): boolean => p === MCP_APPS_PUBLISH_PATH || p === MCP_APPS_PATH || p.startsWith(`${MCP_APPS_PATH}/`)

/** Reads the JSON object body; `{json}` on success, the finished error Result otherwise. */
async function body(read: () => Promise<string>): Promise<{ json: Record<string, unknown> } | { fail: Result }> {
  let raw: string
  try { raw = await read() } catch (err) {
    if (err instanceof BodyReadError) return { fail: { status: err.reason === 'too_large' ? 413 : 400, body: { error: err.reason } } }
    throw err
  }
  try {
    const v: unknown = JSON.parse(raw || '{}')
    if (v && typeof v === 'object' && !Array.isArray(v)) return { json: v as Record<string, unknown> }
  } catch { /* falls through: a bad body is the caller's mistake */ }
  return { fail: { status: 400, body: { error: 'invalid_json' } } }
}

/** null = not an MCP Apps path. */
export async function mcpAppsRoute(req: IncomingMessage, url: URL, read: () => Promise<string>, deps: McpAppsDeps): Promise<Result> {
  const path = url.pathname
  if (!isMcpAppsPath(path)) return null
  const method = (req.method ?? 'GET').toUpperCase()

  if (path === MCP_APPS_PUBLISH_PATH) {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
    const token = headerValue(req.headers, TOKEN_HEADER) ?? nodeTokenFrom((n) => headerValue(req.headers, n))
    const owner = token ? deps.nodeIdForToken(token) : undefined
    if (!owner) return { status: 401, body: { error: 'unauthorized' } }
    const b = await body(read)
    if ('fail' in b) return b.fail
    const mcp = await deps.mcp()
    const r = publishApp({ store: deps.store, policy: mcp.policy, events: mcp.events, now: deps.now }, owner, b.json)
    return r.ok ? { status: 201, body: { appId: r.appId } } : { status: r.status, body: { error: r.error } }
  }

  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return { status: 403, body: { error: denial } }
  const [id = '', action = '', extra] = path.slice(MCP_APPS_PATH.length + 1).split('/')
  if (extra !== undefined || !id) return { status: 404, body: { error: 'unknown_route' } }

  if (id === 'claim' && !action) {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
    const b = await body(read)
    if ('fail' in b) return b.fail
    const nodeIds = Array.isArray(b.json.nodeIds) ? b.json.nodeIds.filter((n): n is string => typeof n === 'string').slice(0, CLAIM_NODES_MAX) : []
    return { status: 200, body: { apps: deps.store.claim(nodeIds).map((a) => ({ id: a.id, ownerNodeId: a.ownerNodeId, uri: a.uri })) } }
  }

  const app = deps.store.get(id)
  if (!app) return { status: 404, body: { error: 'app_not_found' } }
  if (!action) {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    const csp = buildAppCsp(app.csp)
    return {
      status: 200,
      body: {
        id: app.id, uri: app.uri, ownerNodeId: app.ownerNodeId, csp, html: withCspMeta(app.html, csp), permissions: app.permissions,
        ...(app.prefersBorder !== undefined ? { prefersBorder: app.prefersBorder } : {}),
        ...(app.toolInput ? { toolInput: app.toolInput } : {}), ...(app.toolResult ? { toolResult: app.toolResult } : {}),
      },
    }
  }
  if (action === 'call') {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
    const b = await body(read)
    if ('fail' in b) return b.fail
    if (typeof b.json.name !== 'string' || !b.json.name) return { status: 400, body: { error: 'name_required' } }
    const a = b.json.arguments
    const args = a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : {}
    return { status: 200, body: await callAppTool(await deps.mcp(), app, b.json.name, args) }
  }
  return { status: 404, body: { error: 'unknown_route' } }
}

/** Production deps over the process singletons, loaded lazily. */
export async function processMcpAppsDeps(): Promise<McpAppsDeps> {
  const [{ mcpAppStore }, { nodeIdForToken, isValidNodeToken }, { processMcpDeps }] = await Promise.all([
    import('./mcpApp.store'), import('../hooksTokens'), import('../mcp/mcp.route'),
  ])
  return { store: mcpAppStore, nodeIdForToken, isNodeToken: isValidNodeToken, mcp: processMcpDeps, now: Date.now }
}
