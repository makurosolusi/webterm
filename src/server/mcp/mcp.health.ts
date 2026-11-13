// Is webterm's MCP tool server able to start? Two signals for Settings › Health (doctor.ts `tools`):
// an active probe (start the server exactly as agents and Central do, answer `initialize`) and the
// status Claude reported for it in the last Central turn's init (claudeEvents.ts records it).
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { childEnv } from '../childEnv'
import { endChildStdin } from '../childStdin'
import { mcpLaunchBase } from './mcp.launch'

const PROBE_TIMEOUT_MS = 10_000
/** Any valid port: `initialize` is answered locally, the server is never called. */
const PROBE_PORT = 1
/** Never read during `initialize` (headers are read per HTTP request). */
const PROBE_HEADERS = join(tmpdir(), 'webterm-mcp-probe.headers')

export type McpProbe = { ok: true; server: string } | { ok: false; reason: string }

/** Starts the MCP server with `launch` (default: how agents and Central start it) and waits for its `initialize` answer. */
export function probeMcpServer(launch = mcpLaunchBase(), timeoutMs = PROBE_TIMEOUT_MS): Promise<McpProbe> {
  return new Promise((done) => {
    const child = spawn(launch.command, [...launch.args, '--headers', PROBE_HEADERS, '--port', String(PROBE_PORT)], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
    let out = ''
    let err = ''
    let settled = false
    const finish = (r: McpProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      done(r)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: `no answer to initialize within ${timeoutMs} ms` }), timeoutMs)
    child.on('error', (e) => finish({ ok: false, reason: `could not start ${launch.command}: ${e.message}` }))
    child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c })
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      out += c
      const nl = out.indexOf('\n')
      if (nl < 0) return
      try {
        const info = (JSON.parse(out.slice(0, nl)) as { result?: { serverInfo?: { name?: string; version?: string } } }).result?.serverInfo
        finish(info?.name ? { ok: true, server: `${info.name} ${info.version ?? ''}`.trim() } : { ok: false, reason: `unexpected answer: ${out.slice(0, 200)}` })
      } catch {
        finish({ ok: false, reason: `not JSON-RPC on stdout: ${out.slice(0, 200)}` })
      }
    })
    child.on('close', (code) => finish({ ok: false, reason: `exited with code ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''}` }))
    endChildStdin(child.stdin, `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'webterm-doctor', version: '1' } } })}\n`, { op: 'mcp.probe', command: launch.command })
  })
}

export interface CentralMcpSeen { status: string; at: number }
let lastSeen: CentralMcpSeen | null = null

/** Records the webterm MCP server status from a Central turn's init event. */
export function recordCentralMcpStatus(status: string, at = Date.now()): void { lastSeen = { status, at } }
/** Status from the last Central turn's init, or null when no turn ran since the server started. */
export const lastCentralMcpStatus = (): CentralMcpSeen | null => lastSeen
