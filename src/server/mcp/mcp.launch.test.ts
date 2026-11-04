import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeHeadersPath } from '../hooksPaths'
import { claudeNodeSettings } from '../hooksSettings'
import { nodeToken } from '../hooksTokens'
import { launchLine } from '../launchLine'
import { GEMINI_DEFAULTS_ENV, MCP_MAIN, OPENCODE_CONFIG_ENV, codexMcpFlags, mcpConfigPath, mcpEnv } from './mcp.launch'

const DIR = mkdtempSync(join(tmpdir(), 'mcp-launch-'))
const prev = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = DIR // claude's launch line writes real files: keep them out of ~/.webterm-server
afterAll(() => {
  if (prev === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prev
  rmSync(DIR, { recursive: true, force: true })
})
const SID = '0b5f5a8e-9a43-4d4e-9d0c-1a2b3c4d5e6f'
const open = (agentId: string, cmd = agentId) => ({ t: 'open' as const, id: 'n1', cols: 80, rows: 24, cmd, agentId, sessionId: SID })

describe('webterm mcp auto-configuration per CLI', () => {
  it('claude: --mcp-config points at a webterm-owned file naming main.ts and the header file', () => {
    const line = launchLine(open('claude'), 8700) ?? ''
    const m = line.match(/--mcp-config '([^']+)'$/)
    expect(m?.[1]).toBe(mcpConfigPath('n1', 'claude'))
    const cfg = JSON.parse(readFileSync(m![1], 'utf8'))
    expect(cfg.mcpServers.webterm.type).toBe('stdio')
    expect(cfg.mcpServers.webterm.args).toEqual([MCP_MAIN, '--headers', claudeHeadersPath('n1'), '--port', '8700'])
    // Pre-allowed in Claude; the webterm policy is the gate.
    expect((claudeNodeSettings('n1', 8700).permissions as { allow: string[] }).allow).toContain('mcp__webterm')
  })

  it('codex: -c mcp_servers.webterm.command/args as TOML, colon-free', () => {
    const line = launchLine(open('codex'), 8700) ?? ''
    expect(line).toContain(codexMcpFlags('n1', 8700))
    expect(codexMcpFlags('n1', 8700)).toContain(`mcp_servers.webterm.args=["${MCP_MAIN}","--headers","${claudeHeadersPath('n1')}","--port","8700"]`)
    expect(codexMcpFlags('n1', 8700)).not.toContain(':')
  })

  it('opencode and gemini: env pointing at the server; other agents get nothing', () => {
    const written: Array<[string, string]> = []
    const oc = JSON.parse(mcpEnv('opencode', 'n1', 8700)[OPENCODE_CONFIG_ENV])
    expect(oc.mcp.webterm).toMatchObject({ type: 'local', enabled: true })
    expect(oc.mcp.webterm.command.slice(1)).toEqual([MCP_MAIN, '--headers', claudeHeadersPath('n1'), '--port', '8700'])
    const gem = mcpEnv('gemini', 'n1', 8700, (p, t) => written.push([p, t]))
    expect(gem[GEMINI_DEFAULTS_ENV]).toBe(mcpConfigPath('n1', 'gemini'))
    expect(JSON.parse(written[0][1]).mcpServers.webterm.args[0]).toBe(MCP_MAIN)
    expect(mcpEnv('copilot', 'n1', 8700)).toEqual({})
  })

  it('never carries the node token in argv, env or the config files', () => {
    const token = nodeToken('n1')
    const lines = ['claude', 'codex'].map((a) => launchLine(open(a), 8700) ?? '')
    const env = JSON.stringify([mcpEnv('opencode', 'n1', 8700), mcpEnv('gemini', 'n1', 8700, () => {})])
    for (const text of [...lines, env, readFileSync(mcpConfigPath('n1', 'claude'), 'utf8')]) expect(text).not.toContain(token)
  })
})
