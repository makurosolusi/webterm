// MCP Apps published by agents, held in memory: a view is the HTML an agent read from its own MCP
// session (`resources/read` on a `ui://` URI) plus the tool call it belongs to. The App node's canvas
// id IS the app id, so the board needs no new persisted field.
// ponytail: in-memory, lost on restart (the node then says so); move to the ledger if apps must survive one.
import { randomUUID } from 'node:crypto'
import { cleanCspDomains, type McpAppCsp } from './mcpApp.csp'

/** MIME type of an MCP Apps view (SEP-1865 2026-01-26; the only one that version defines). */
export const MCP_APP_MIME = 'text/html;profile=mcp-app'
export const MCP_APP_URI_SCHEME = 'ui://'
export const MCP_APP_HTML_MAX_CHARS = 2 * 1024 * 1024
/** Apps kept at once; the oldest is dropped past this. */
export const MCP_APP_MAX = 64

/** `_meta.ui.permissions` keys the host maps to Permission Policy features. */
export const APP_PERMISSIONS = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' } as const
export type AppPermission = keyof typeof APP_PERMISSIONS

export interface McpApp {
  id: string
  /** Node whose token published it; the App node is placed next to it. */
  ownerNodeId: string
  uri: string
  html: string
  csp: McpAppCsp
  permissions: AppPermission[]
  prefersBorder?: boolean
  toolInput?: Record<string, unknown>
  toolResult?: Record<string, unknown>
  claimed: boolean
  createdAt: number
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined)

/** The app described by an untrusted publish body, or the reason it is refused. */
export function parseAppResource(body: unknown): { ok: true; app: Omit<McpApp, 'id' | 'ownerNodeId' | 'claimed' | 'createdAt'> } | { ok: false; error: string } {
  const b = obj(body) ?? {}
  // Accept the `resources/read` result as is ({contents: [item]}) or the content item itself.
  const r = obj(b.resource)
  const item = Array.isArray(r?.contents) ? obj(r.contents[0]) : r
  if (!item) return { ok: false, error: 'resource_required' }
  if (typeof item.uri !== 'string' || !item.uri.startsWith(MCP_APP_URI_SCHEME)) return { ok: false, error: 'invalid_uri' }
  if (item.mimeType !== MCP_APP_MIME) return { ok: false, error: 'invalid_mime_type' }
  const html = typeof item.text === 'string' ? item.text : typeof item.blob === 'string' ? Buffer.from(item.blob, 'base64').toString('utf8') : undefined
  if (html === undefined || html === '') return { ok: false, error: 'html_required' }
  if (html.length > MCP_APP_HTML_MAX_CHARS) return { ok: false, error: 'html_too_large' }
  const ui = obj(obj(item._meta)?.ui) ?? {}
  const c = obj(ui.csp) ?? {}
  const csp: McpAppCsp = {}
  for (const k of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const) {
    const d = cleanCspDomains(c[k])
    if (d.length) csp[k] = d
  }
  const permissions = Object.keys(obj(ui.permissions) ?? {}).filter((k): k is AppPermission => k in APP_PERMISSIONS)
  return {
    ok: true,
    app: {
      uri: item.uri, html, csp, permissions,
      ...(typeof ui.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}),
      ...(obj(b.toolInput) ? { toolInput: obj(b.toolInput) } : {}),
      ...(obj(b.toolResult) ? { toolResult: obj(b.toolResult) } : {}),
    },
  }
}

export interface McpAppStore {
  add(ownerNodeId: string, app: Omit<McpApp, 'id' | 'ownerNodeId' | 'claimed' | 'createdAt'>, now: number): McpApp
  get(id: string): McpApp | undefined
  /** Unclaimed apps owned by one of `nodeIds`, now marked claimed (each is placed on the canvas once). */
  claim(nodeIds: readonly string[]): McpApp[]
}

export function createMcpAppStore(max = MCP_APP_MAX): McpAppStore {
  const apps = new Map<string, McpApp>()
  return {
    add(ownerNodeId, app, now) {
      const rec: McpApp = { ...app, id: `app-${randomUUID()}`, ownerNodeId, claimed: false, createdAt: now }
      apps.set(rec.id, rec)
      // Map keeps insertion order: the first key is the oldest.
      while (apps.size > max) apps.delete(apps.keys().next().value as string)
      return rec
    },
    get: (id) => apps.get(id),
    claim(nodeIds) {
      const owners = new Set(nodeIds)
      const out = [...apps.values()].filter((a) => !a.claimed && owners.has(a.ownerNodeId))
      for (const a of out) a.claimed = true
      return out
    },
  }
}

/** The process store (routes use it; tests build their own). */
export const mcpAppStore: McpAppStore = createMcpAppStore()
