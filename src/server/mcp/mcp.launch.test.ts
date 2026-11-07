import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeHeadersPath } from '../hooksPaths'
import { claudeNodeSettings } from '../hooksSettings'
import { nodeToken } from '../hooksTokens'
import { launchLine } from '../launchLine'
import { MCP_MAIN, mcpConfigPath } from './mcp.launch'

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

describe('webterm mcp auto-configuration', () => {
  it('claude: --mcp-config points at a webterm-owned file naming main.ts and the header file', () => {
    const line = launchLine(open('claude'), 8700) ?? ''
    const m = line.match(/--mcp-config '([^']+)'$/)
    expect(m?.[1]).toBe(mcpConfigPath('n1'))
    const cfg = JSON.parse(readFileSync(m![1], 'utf8'))
    expect(cfg.mcpServers.webterm.type).toBe('stdio')
    expect(cfg.mcpServers.webterm.args).toEqual([MCP_MAIN, '--headers', claudeHeadersPath('n1'), '--port', '8700'])
    // Pre-allowed in Claude; the webterm policy is the gate.
    expect((claudeNodeSettings('n1', 8700).permissions as { allow: string[] }).allow).toContain('mcp__webterm')
  })

  it('a non-Claude CLI (a plain terminal program now) gets no MCP flags', () => {
    expect(launchLine(open('codex'), 8700)).toBe('codex')
  })

  it('never carries the node token in argv, env or the config files', () => {
    const token = nodeToken('n1')
    const line = launchLine(open('claude'), 8700) ?? ''
    for (const text of [line, readFileSync(mcpConfigPath('n1'), 'utf8')]) expect(text).not.toContain(token)
  })
})
