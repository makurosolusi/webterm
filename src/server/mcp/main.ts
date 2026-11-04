// `webterm mcp`: stdio MCP server one agent CLI spawns per node (`bun <this file> --headers <path> --port <n>`).
// A thin client: tools and calls go to the webterm server (`/api/control/mcp/*`), which proves the node
// from its token, runs policy and audits. The token is read from the node's own 0600 header file on
// every request (a restarted server rewrites it), never from argv or env (hooksPaths.ts NODE_HEADERS_ENV).
// stdout carries JSON-RPC only; diagnostics go to stderr (MCP stdio transport).
// Central mode (`--approval-wait-ms <n>`, mcp.central.ts): a call answered "approval card pending" is
// re-asked every APPROVAL_POLL_MS until a human decides or the wait ends, so an approved call finishes
// inside the same turn. Short polls instead of one long request: no HTTP timeout to outlive.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { APPROVAL_PENDING, MCP_CALL_PATH, MCP_TOOLS_PATH } from './mcp.paths'
import { handleLine, type McpBackend, type McpTool } from './mcp.protocol'

export interface McpArgs { headers: string; port: number; approvalWaitMs: number }
export const APPROVAL_POLL_MS = 500
const MAX_APPROVAL_WAIT_MS = 30 * 60_000

/** `--headers <path> --port <n> [--approval-wait-ms <n>]`; throws with the bad flag named. */
export function parseArgs(argv: readonly string[]): McpArgs {
  const at = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const headers = at('--headers')
  const port = Number(at('--port'))
  if (!headers) throw new Error('webterm mcp: --headers <file> is required')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('webterm mcp: --port <1-65535> is required')
  const rawWait = at('--approval-wait-ms')
  const approvalWaitMs = rawWait === undefined ? 0 : Number(rawWait)
  if (!Number.isInteger(approvalWaitMs) || approvalWaitMs < 0 || approvalWaitMs > MAX_APPROVAL_WAIT_MS) {
    throw new Error(`webterm mcp: --approval-wait-ms must be 0-${MAX_APPROVAL_WAIT_MS}`)
  }
  return { headers, port, approvalWaitMs }
}

/** `Name: value` lines of a curl header file. */
export function readHeaderFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

const awaitingHuman = (r: Record<string, unknown>): boolean =>
  r.detail === 'approval_required' && (r.evidence as Record<string, unknown> | undefined)?.approvalStatus === APPROVAL_PENDING

/** Backend over the webterm server HTTP API, authenticated with the node's header file. */
export function httpBackend(args: McpArgs, fetchImpl: typeof fetch = fetch, pollMs = APPROVAL_POLL_MS): McpBackend {
  const base = `http://127.0.0.1:${args.port}`
  const request = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...readHeaderFile(args.headers), 'content-type': 'application/json' } })
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') throw new Error(`${path} answered ${res.status} without JSON`)
    if (res.status === 401) throw new Error('webterm rejected this node token (node closed or server restarted without it)')
    return body
  }
  return {
    async list() {
      const body = await request(MCP_TOOLS_PATH)
      return Array.isArray(body.tools) ? body.tools as McpTool[] : []
    },
    async call(name, callArgs) {
      const deadline = Date.now() + args.approvalWaitMs
      for (;;) {
        const r = await request(MCP_CALL_PATH, { method: 'POST', body: JSON.stringify({ name, arguments: callArgs }) })
        if (!awaitingHuman(r) || Date.now() + pollMs > deadline) return r
        await new Promise((done) => setTimeout(done, pollMs))
      }
    },
  }
}

/** Serves stdin → stdout until stdin closes. Requests are answered in arrival order. */
export async function serve(backend: McpBackend, input: NodeJS.ReadableStream = process.stdin, write = (s: string) => process.stdout.write(s)): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity })
  for await (const line of rl) {
    const res = await handleLine(line, backend)
    if (res) write(`${JSON.stringify(res)}\n`)
  }
}

if (import.meta.main) {
  try {
    await serve(httpBackend(parseArgs(process.argv.slice(2))))
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
