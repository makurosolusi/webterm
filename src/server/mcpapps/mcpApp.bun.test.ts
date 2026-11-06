// Bun-only (real policy engine on the real ledger schema): MCP Apps publish/claim/view routes, the CSP
// a view gets, and the view's tools/call going through webterm policy as the App node itself.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import type { Workspace, WsNode } from '../../shared/workspace'
import { freshDb } from '../central/guard/controlGuard.testutil'
import { CAP_DEFS } from '../central/tools/defs/cap.defs'
import { createRegistry } from '../central/tools/toolRegistry'
import type { ControlRequest } from '../control/controlTypes'
import { createEventLog } from '../events/eventLog'
import { callTool, listTools, type McpDeps } from '../mcp/mcp.tools'
import { createPolicy } from '../policy/policy.decide'
import { buildAppCsp, withCspMeta } from './mcpApp.csp'
import { mcpAppsRoute, type McpAppsDeps } from './mcpApp.route'
import { APP_PUBLISHED_EVENT, publishApp } from './mcpApp.publish'
import { createMcpAppStore, MCP_APP_MIME, parseAppResource } from './mcpApp.store'

const AGENT_TOKEN = 'node-token-a1' // test-only
const node = (id: string, kind: string): WsNode => ({ id, kind: kind as WsNode['kind'], x: 0, y: 0 })
const BOARD: Workspace[] = [{
  id: 'w1', name: 'w', cwd: '/tmp', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0,
  nodes: [node('a1', 'agent'), node('b1', 'browser')], bridges: [],
}]

const db = freshDb()
const registry = createRegistry()
for (const def of CAP_DEFS) registry.register(def)
const browserCalls: ControlRequest[] = []
const events = createEventLog(db)
const policy = createPolicy({ db, workspaces: () => BOARD })
const mcp: McpDeps = {
  policy,
  workspaces: () => BOARD,
  central: { db, registry, env: {} },
  browser: async (req) => { browserCalls.push(req); return { status: 200, body: { ok: true } } },
  gitDiff: async () => ({ status: 200, body: { files: [] } }),
  events,
}
const store = createMcpAppStore()
mcp.apps = store
const deps: McpAppsDeps = {
  store, mcp: async () => mcp, now: () => 1,
  nodeIdForToken: (t) => (t === AGENT_TOKEN ? 'a1' : undefined),
  isNodeToken: (t) => t === AGENT_TOKEN,
}

const UI = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, host: '127.0.0.1:8700' }
const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as unknown as IncomingMessage
const hit = (method: string, path: string, body?: unknown, headers: Record<string, string> = UI) =>
  mcpAppsRoute(req(method, headers), new URL(path, 'http://127.0.0.1:8700'), async () => (body === undefined ? '' : JSON.stringify(body)), deps)

const RESOURCE = {
  uri: 'ui://weather/forecast', mimeType: MCP_APP_MIME, text: '<!doctype html><html><body><script>1</script></body></html>',
  _meta: { ui: { csp: { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com', "evil.com; script-src 'unsafe-eval'"] }, permissions: { camera: {}, usb: {} } } },
}

describe('publish', () => {
  test('a node token publishes a ui:// resource; the owner is the token, not the body', async () => {
    const r = await hit('POST', '/api/control/mcpapps', { resource: { contents: [RESOURCE] }, toolInput: { city: 'Paris' }, ownerNodeId: 'b1' }, { 'x-webterm-token': AGENT_TOKEN })
    expect(r?.status).toBe(201)
    const id = (r?.body as { appId: string }).appId
    expect(store.get(id)?.ownerNodeId).toBe('a1')
    expect(store.get(id)?.permissions).toEqual(['camera'])
  })
  test('no token is 401; a non-mcp-app resource is 400', async () => {
    expect((await hit('POST', '/api/control/mcpapps', { resource: RESOURCE }, {}))?.status).toBe(401)
    const bad = await hit('POST', '/api/control/mcpapps', { resource: { ...RESOURCE, mimeType: 'text/html' } }, { 'x-webterm-token': AGENT_TOKEN })
    expect(bad).toEqual({ status: 400, body: { error: 'invalid_mime_type' } })
    expect(parseAppResource({ resource: { ...RESOURCE, uri: 'https://x' } })).toEqual({ ok: false, error: 'invalid_uri' })
  })
})

describe('UI routes', () => {
  test('claim hands each app out once, only for nodes on the caller canvas', async () => {
    const a = store.add('a1', { uri: 'ui://x', html: '<p>x</p>', csp: {}, permissions: [] }, 1)
    expect(((await hit('POST', '/api/mcpapps/claim', { nodeIds: ['b1'] }))?.body as { apps: unknown[] }).apps.some((x) => (x as { id: string }).id === a.id)).toBe(false)
    const first = (await hit('POST', '/api/mcpapps/claim', { nodeIds: ['a1'] }))?.body as { apps: { id: string }[] }
    expect(first.apps.map((x) => x.id)).toContain(a.id)
    const again = (await hit('POST', '/api/mcpapps/claim', { nodeIds: ['a1'] }))?.body as { apps: { id: string }[] }
    expect(again.apps.map((x) => x.id)).not.toContain(a.id)
  })
  test('an agent token cannot read views or call tools as an app', async () => {
    const a = store.add('a1', { uri: 'ui://x', html: '<p>x</p>', csp: {}, permissions: [] }, 1)
    expect((await hit('GET', `/api/mcpapps/${a.id}`, undefined, { ...UI, 'x-webterm-token': AGENT_TOKEN }))?.status).toBe(403)
    expect((await hit('POST', `/api/mcpapps/${a.id}/call`, { name: 'browser_act' }, { ...UI, 'x-webterm-token': AGENT_TOKEN }))?.status).toBe(403)
    expect((await hit('GET', `/api/mcpapps/${a.id}`, undefined, {}))?.status).toBe(403) // not a same-origin page
  })
  test('the view carries the resource CSP as its first element after the doctype', async () => {
    const parsed = parseAppResource({ resource: RESOURCE })
    if (!parsed.ok) throw new Error(parsed.error)
    const a = store.add('a1', parsed.app, 1)
    const v = (await hit('GET', `/api/mcpapps/${a.id}`))?.body as { html: string; csp: string }
    expect(v.csp).toContain('connect-src https://api.example.com')
    expect(v.csp).toContain('script-src \'unsafe-inline\' \'unsafe-eval\' blob: data: https://cdn.example.com')
    expect(v.csp).not.toContain('evil.com')
    expect(v.html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';`)).toBe(true)
    expect(v.html.indexOf('<script>')).toBeGreaterThan(v.html.indexOf('Content-Security-Policy'))
  })
})

describe('CSP', () => {
  test('no declared csp is the spec default: no network, no frames, no base, never self', () => {
    const csp = buildAppCsp()
    for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "base-uri 'none'", "object-src 'none'"]) expect(csp).toContain(d)
    expect(csp).not.toContain("'self'")
  })
  test('the meta content is attribute-escaped', () => {
    expect(withCspMeta('<p>', 'a"b')).toBe('<meta http-equiv="Content-Security-Policy" content="a&quot;b"><p>')
  })
})

describe('tools/call through policy', () => {
  test('an unwired app node is denied browser_act and the browser is never reached', async () => {
    const a = store.add('a1', { uri: 'ui://x', html: '<p>x</p>', csp: {}, permissions: [] }, 1)
    const r = await hit('POST', `/api/mcpapps/${a.id}/call`, { name: 'browser_act', arguments: { verb: 'navigate', url: 'https://example.com/' } })
    expect(r?.status).toBe(200)
    const out = r?.body as { isError: boolean; structuredContent: { outcome: string; detail: string } }
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ outcome: 'denied', detail: 'policy_denied' })
    expect(browserCalls).toHaveLength(0)
  })
  test('the call is audited as the app node, not the agent that published it', async () => {
    const a = store.add('a1', { uri: 'ui://x', html: '<p>x</p>', csp: {}, permissions: [] }, 1)
    await hit('POST', `/api/mcpapps/${a.id}/call`, { name: 'cap_search', arguments: { query: 'browser' } })
    const actors = events.list().filter((e) => e.kind === 'mcp.call').map((e) => e.actor)
    expect(actors).toContain(`node:${a.id}`)
    expect(actors).not.toContain('node:a1')
  })
})

describe('publish path shared by the route and the MCP tool', () => {
  test('publishing emits mcpapp.published with ids and the URI, never the HTML', () => {
    const r = publishApp({ store, policy, events, now: () => 1 }, 'a1', { uri: 'ui://x/y', html: '<p>secret-ish</p>' })
    if (!r.ok) throw new Error(r.error)
    const e = events.list().filter((x) => x.kind === APP_PUBLISHED_EVENT).at(-1)
    expect(e).toMatchObject({ actor: 'node:a1', nodeId: 'a1', trust: 'untrusted', payload: { appId: r.appId, uri: 'ui://x/y' } })
    expect(JSON.stringify(e?.payload)).not.toContain('secret-ish')
  })
  test('a user deny rule for app.open wins over the builtin allow', () => {
    expect(policy.createGrant('human-ui', { subject: 'node:a9', capability: 'app.open', effect: 'deny' }).ok).toBe(true)
    expect(publishApp({ store, policy, events, now: () => 1 }, 'a9', { uri: 'ui://x', html: '<p>' })).toEqual({ ok: false, status: 403, error: 'policy_denied' })
    expect(publishApp({ store, policy: null, events, now: () => 1 }, 'a1', { uri: 'ui://x', html: '<p>' })).toMatchObject({ ok: false, error: 'policy_unavailable' })
  })
  test('MCP app_open is listed, publishes for the calling node and ignores an owner in the body', async () => {
    expect(listTools(mcp).map((t) => t.name)).toContain('app_open')
    const r = await callTool(mcp, 'a1', '', 'app_open', { uri: 'ui://weather/forecast', html: '<p>hi</p>', toolInput: { city: 'Paris' }, ownerNodeId: 'b1' })
    const appId = (r.data as { appId: string }).appId
    expect([r.outcome, appId.startsWith('app-')]).toEqual(['ok', true])
    const app = store.get(appId)
    expect(app).toMatchObject({ ownerNodeId: 'a1', uri: 'ui://weather/forecast', toolInput: { city: 'Paris' } })
  })
  test('MCP app_open refuses a non-ui:// URI with a stable code', async () => {
    expect(await callTool(mcp, 'a1', '', 'app_open', { uri: 'https://x', html: '<p>' })).toMatchObject({ outcome: 'error', detail: 'invalid_uri' })
  })
})
