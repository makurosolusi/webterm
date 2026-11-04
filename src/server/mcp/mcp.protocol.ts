// Dual-era MCP JSON-RPC dispatcher (pure: no I/O, vitest-safe). Spec revision 2026-07-28
// (modelcontextprotocol.io/specification/2026-07-28): stateless requests carrying their version in
// `_meta`, mandatory `server/discover`, `resultType` on every result, `ttlMs`/`cacheScope` on lists.
// Legacy clients (Claude Code / Codex / OpenCode / Gemini installed today still open with
// `initialize`) are served per the spec's "Backward Compatibility" section: `initialize` selects
// legacy semantics for the stdio process. No sampling, roots or logging (deprecated, SEP-2577).
// ponytail: hand-rolled instead of @modelcontextprotocol/sdk 1.32.2, whose newest version is 2025-11-25
// (no server/discover); switch when the SDK speaks 2026-07-28 and dual-era is no longer worth owning.

export const MODERN_VERSION = '2026-07-28'
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
export const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS]
export const SERVER_INFO = { name: 'webterm', version: '1.0.0' } as const
/** Tool list freshness hint: the catalog changes only when a feature flag flips. */
export const LIST_TTL_MS = 60_000
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_SERVER = 'io.modelcontextprotocol/serverInfo'

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, unsupportedVersion: -32022 } as const

export const INSTRUCTIONS = 'webterm canvas capabilities. Every tool answers with a receipt {outcome, detail, next, evidence, data}. '
  + 'outcome "denied" means a webterm policy rule refused it: only the user can change that, do not retry. Use cap_search to find tools.'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
}

/** Where tools come from and calls go to (HTTP to the webterm server in `main.ts`, a fake in tests). */
export interface McpBackend {
  list(): Promise<McpTool[]>
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
}

type Id = string | number
export interface RpcMessage { jsonrpc?: string; id?: Id | null; method?: unknown; params?: unknown }
export type RpcResponse = { jsonrpc: '2.0'; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string; data?: unknown } })

export const rpcError = (id: Id | null, code: number, message: string, data?: unknown): RpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result })
const complete = (body: Record<string, unknown>) => ({ resultType: 'complete', ...body, _meta: { [META_SERVER]: SERVER_INFO } })

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** Answers one JSON-RPC message; null for notifications (no `id`), which never get a response. */
export async function handleRpc(msg: RpcMessage, backend: McpBackend): Promise<RpcResponse | null> {
  if (msg.id === undefined || msg.id === null) return null
  const id = msg.id
  if (typeof msg.method !== 'string') return rpcError(id, RPC.invalidRequest, 'method is required')
  const params = asObj(msg.params)
  const requested = asObj(params._meta)[META_VERSION]
  if (requested !== undefined && !SUPPORTED_VERSIONS.includes(String(requested))) {
    return rpcError(id, RPC.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested })
  }
  switch (msg.method) {
    case 'initialize': {
      // Legacy handshake: echo the client's version when we speak it, else offer our newest legacy one.
      const want = String(params.protocolVersion ?? '')
      const version = (LEGACY_VERSIONS as readonly string[]).includes(want) ? want : LEGACY_VERSIONS[0]
      return ok(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS })
    }
    case 'ping': return ok(id, {})
    case 'server/discover':
      return ok(id, complete({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: LIST_TTL_MS, cacheScope: 'private' }))
    case 'tools/list': {
      const tools = [...await backend.list()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return ok(id, complete({ tools, ttlMs: LIST_TTL_MS, cacheScope: 'private' }))
    }
    case 'tools/call': {
      if (typeof params.name !== 'string' || !params.name) return rpcError(id, RPC.invalidParams, 'name is required')
      const receipt = await backend.call(params.name, asObj(params.arguments))
      return ok(id, complete({
        content: [{ type: 'text', text: JSON.stringify(receipt) }],
        structuredContent: receipt,
        isError: receipt.outcome !== 'ok',
      }))
    }
    default: return rpcError(id, RPC.methodNotFound, `method not found: ${msg.method}`)
  }
}

/** Parses one stdio line (newline-delimited JSON-RPC) and answers it; parse failures answer -32700. */
export async function handleLine(line: string, backend: McpBackend): Promise<RpcResponse | null> {
  if (!line.trim()) return null
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return rpcError(null, RPC.parse, 'parse error')
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, RPC.invalidRequest, 'expected a JSON-RPC object')
  try {
    return await handleRpc(msg as RpcMessage, backend)
  } catch (err) {
    const id = (msg as RpcMessage).id ?? null
    // The backend failed (webterm unreachable, bad response); name the operation, never echo input.
    return rpcError(id, RPC.internal, `webterm backend failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
