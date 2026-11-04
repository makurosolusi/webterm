// One publish path for an MCP Apps view, shared by the control route (`POST /api/control/mcpapps`) and
// the webterm MCP tool `app_open` (mcp.tools.ts): policy decision for the proven node, parse, store,
// and a `mcpapp.published` event the canvas watcher reacts to over the events SSE stream.
import type { EventLog } from '../events/eventLog'
import type { Policy } from '../policy/policy.decide'
import type { Grant } from '../policy/policy.model'
import { APP_OPEN_CAPABILITY } from './mcpApp.capabilities'
import { MCP_APP_MIME, parseAppResource, type McpAppStore } from './mcpApp.store'

export const APP_PUBLISHED_EVENT = 'mcpapp.published'

/**
 * Builtin allow for a node to open apps on its own canvas, in the cable slot (like mcp.tools `readGrants`):
 * zero-config, yet any rule the user writes for `app.open` comes later and wins (last match).
 */
export const appOpenGrant = (principal: string): Grant => ({
  id: `mcpapp-open:${principal}`, subject: principal, capability: APP_OPEN_CAPABILITY, scope: '*', effect: 'allow',
  expiresAt: null, origin: 'builtin', createdBy: 'human-ui', createdAt: 0,
})

export interface PublishDeps {
  store: McpAppStore
  /** Null = ledger off: refused (fail closed, as every MCP tool). */
  policy: Pick<Policy, 'decide'> | null
  events: Pick<EventLog, 'append'> | null
  now(): number
}

export type PublishResult = { ok: true; appId: string } | { ok: false; status: 400 | 403; error: string }

/** `{uri, html}` shorthand -> the `resources/read` content item `parseAppResource` reads. */
export function resourceBody(args: Record<string, unknown>): Record<string, unknown> {
  if (args.resource !== undefined || typeof args.uri !== 'string' || typeof args.html !== 'string') return args
  const { uri, html, ...rest } = args
  return { ...rest, resource: { uri, mimeType: MCP_APP_MIME, text: html } }
}

/** Publishes for `ownerNodeId`, the node its credential proves; the body never names the owner. */
export function publishApp(deps: PublishDeps, ownerNodeId: string, body: unknown): PublishResult {
  const principal = `node:${ownerNodeId}`
  if (!deps.policy) return { ok: false, status: 403, error: 'policy_unavailable' }
  const d = deps.policy.decide(principal, APP_OPEN_CAPABILITY, { cable: [appOpenGrant(principal)] })
  if (d.effect !== 'allow') return { ok: false, status: 403, error: d.effect === 'ask' ? 'approval_required' : 'policy_denied' }
  const parsed = parseAppResource(body && typeof body === 'object' && !Array.isArray(body) ? resourceBody(body as Record<string, unknown>) : body)
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
  const app = deps.store.add(ownerNodeId, parsed.app, deps.now())
  // Untrusted: the URI comes from a third-party MCP server. Only ids and the URI, never the HTML.
  deps.events?.append({
    kind: APP_PUBLISHED_EVENT, source: 'mcpapps', actor: principal, trust: 'untrusted', subject: `app:${app.id}`,
    nodeId: ownerNodeId, payload: { appId: app.id, uri: app.uri },
  })
  return { ok: true, appId: app.id }
}
