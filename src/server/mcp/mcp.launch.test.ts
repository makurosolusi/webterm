import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserAllowRules, browserShimPath } from '../browserAgentShim'
import { cliPath } from '../cli/cli.launcher'
import { claudeHeadersPath } from '../hooksPaths'
import { claudeNodeSettings } from '../hooksSettings'
import { nodeToken } from '../hooksTokens'
import { launchLine } from '../launchLine'
import { isCompiledBinary } from '../selfLaunch'
import { MCP_MAIN, mcpConfigPath, mcpLaunchBase } from './mcp.launch'

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

describe('mcpLaunchBase', () => {
  it('dev: the running bun (or bun on PATH) + main.ts', () => {
    expect(mcpLaunchBase(false)).toEqual({ command: process.versions.bun ? process.execPath : 'bun', args: [MCP_MAIN] })
  })

  it('compiled binary: the binary itself with the hidden __mcp-stdio subcommand, never a /$bunfs path', () => {
    expect(mcpLaunchBase(true)).toEqual({ command: process.execPath, args: ['__mcp-stdio'] })
  })

  it('detects the compiled binary from a /$bunfs (POSIX) or ~BUN (Windows) module URL only', () => {
    expect(isCompiledBinary('file:///$bunfs/root/webterm')).toBe(true)
    expect(isCompiledBinary('file:///B:/~BUN/root/webterm.exe')).toBe(true)
    expect(isCompiledBinary('file:///Users/me/webterm/src/server/selfLaunch.ts')).toBe(false)
    expect(isCompiledBinary()).toBe(false) // this test runs from source
  })
})

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

  it('pre-allows exactly the browser CLI forms a session can run, never blanket webterm or Bash', () => {
    const { allow } = claudeNodeSettings('n1', 8700).permissions as { allow: string[] }
    expect(allow).toEqual(['mcp__webterm', 'Bash(webterm browser *)', `Bash(${browserShimPath()} *)`, `Bash(${cliPath()} browser *)`])
    for (const blanket of ['Bash', 'Bash(*)', 'Bash(webterm *)', 'Bash(webterm:*)']) expect(allow).not.toContain(blanket)
  })

  it('leaves out absolute forms a shell would have to quote, since rules match the command as written', () => {
    process.env.WEBTERM_DATA_DIR = join(DIR, 'a b') // test-only
    try {
      expect(browserAllowRules()).toEqual(['Bash(webterm browser *)'])
    } finally {
      process.env.WEBTERM_DATA_DIR = DIR
    }
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
