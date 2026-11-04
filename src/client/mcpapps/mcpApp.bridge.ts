// Host side of the MCP Apps postMessage JSON-RPC bridge (SEP-1865, spec 2026-01-26), after the ext-apps
// reference host (examples/basic-host + app-bridge). Pure: the App node hands it a `post` to the view
// frame and the host actions; every message from the view goes through `handle`.
//
// Order the spec requires: nothing is sent to the view before its `ui/notifications/initialized`; then
// `tool-input` (at most once) and `tool-result`. `tools/call` is proxied to webterm's policy path only.

export const APP_PROTOCOL_VERSION = '2026-01-26'
export const HOST_INFO = { name: 'webterm', version: '1.0.0' } as const
/** JSON-RPC error codes: the spec's host error for ui/* requests, and the standard ones. */
export const BRIDGE_ERR = { host: -32000, methodNotFound: -32601, invalidParams: -32602 } as const

type Id = string | number
export interface RpcMsg { jsonrpc?: string; id?: Id | null; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

export interface BridgeHost {
  /** Sends one JSON-RPC message to the view frame. */
  post(msg: Record<string, unknown>): void
  /** The view's tools/call; resolves with an MCP CallToolResult. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Opens an http(s) link outside the canvas. */
  openLink(url: string): void
  theme: 'light' | 'dark'
  toolInput?: Record<string, unknown>
  toolResult?: Record<string, unknown>
}

export interface Bridge {
  handle(msg: unknown): Promise<void>
  /** `ui/resource-teardown` before the node goes away (the reply is not awaited on unmount). */
  teardown(reason: string): void
  readonly initialized: boolean
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function hostContext(theme: 'light' | 'dark') {
  return { theme, displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web' }
}

export function createAppBridge(host: BridgeHost): Bridge {
  let initialized = false
  let teardownSeq = 0
  const reply = (id: Id, result: unknown) => host.post({ jsonrpc: '2.0', id, result })
  const fail = (id: Id, code: number, message: string) => host.post({ jsonrpc: '2.0', id, error: { code, message } })
  const notify = (method: string, params: unknown) => host.post({ jsonrpc: '2.0', method, params })

  async function request(id: Id, method: string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case 'ui/initialize':
        return reply(id, {
          protocolVersion: APP_PROTOCOL_VERSION,
          // Only what webterm really does: proxied tools, links, logs. No ui/message, no resources/read.
          hostCapabilities: { serverTools: {}, openLinks: {}, logging: {} },
          hostInfo: HOST_INFO,
          hostContext: hostContext(host.theme),
        })
      case 'ping': return reply(id, {})
      case 'tools/call': {
        if (typeof params.name !== 'string' || !params.name) return fail(id, BRIDGE_ERR.invalidParams, 'name is required')
        try {
          return reply(id, await host.callTool(params.name, asObj(params.arguments)))
        } catch (e) {
          return fail(id, BRIDGE_ERR.host, `tools/call ${params.name} failed: ${errText(e)}`)
        }
      }
      case 'ui/open-link': {
        const url = typeof params.url === 'string' ? params.url : ''
        if (!/^https?:\/\//i.test(url)) return fail(id, BRIDGE_ERR.host, 'only http and https links can be opened')
        host.openLink(url)
        return reply(id, {})
      }
      default: return fail(id, BRIDGE_ERR.methodNotFound, `method not supported by webterm: ${method}`)
    }
  }

  function notification(method: string): void {
    if (method === 'ui/notifications/initialized') {
      if (initialized) return
      initialized = true
      if (host.toolInput) notify('ui/notifications/tool-input', { arguments: host.toolInput })
      if (host.toolResult) notify('ui/notifications/tool-result', host.toolResult)
      return
    }
    // size-changed: the node is user-resized, the view fills it. notifications/message (view logs) and
    // anything else: dropped; the view must not write to webterm logs.
  }

  return {
    get initialized() { return initialized },
    async handle(raw) {
      const msg = asObj(raw) as RpcMsg
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return // replies to our teardown, junk
      if (msg.id === undefined || msg.id === null) return notification(msg.method)
      return request(msg.id, msg.method, asObj(msg.params))
    },
    teardown(reason) {
      if (initialized) host.post({ jsonrpc: '2.0', id: `teardown-${++teardownSeq}`, method: 'ui/resource-teardown', params: { reason } })
    },
  }
}

/** iframe `allow` for the Permission Policy features the resource requested (spec `_meta.ui.permissions`). */
export function allowAttribute(permissions: readonly string[]): string {
  const map: Record<string, string> = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' }
  return permissions.flatMap((p) => (map[p] ? [map[p]] : [])).join('; ')
}

/**
 * Sandbox of the view frame: scripts only. Never `allow-same-origin` (with `allow-scripts` on a srcdoc
 * that would hand the view the webterm origin: its storage, its token, its DOM), no top navigation,
 * popups, forms or downloads; links go through `ui/open-link`.
 */
export const APP_SANDBOX = 'allow-scripts'
