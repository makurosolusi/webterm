import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntime } from './claudeRuntime'
import type { ClaudeReady, ClaudeRuntimeOptions } from './claudeOptions'
import { initRecord, recorder, resultRecord, turnInput } from './claude.fakeBin'
import { type FakeCall, type FakePlay, fakeQuery } from './claude.fakeQuery'
import { createCentralMcpLink } from './claudeMcp'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-safety-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const OK_RECORDS = [initRecord(), resultRecord()]

function runtime(play: FakePlay = OK_RECORDS, extra: Partial<ClaudeRuntimeOptions> = {}) {
  const fake = fakeQuery(play)
  const rt = new ClaudeRuntime({
    query: fake.query, workDir: join(dir, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    // test-only token: keeps the process capability store (and its import graph) out of these tests
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
    ...extra,
  })
  return Object.assign(rt, { calls: fake.calls })
}

describe('ClaudeRuntime child isolation', () => {
  it('scrubs WEBTERM_/NODETERM_/provider/capability values from the child env', async () => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C',
      WEBTERM_TOKEN: 'root', NODETERM_NODE_ID: 'n1', NODETERM_PORT: '1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 'k', MY_CAP: 'wcap_deadbeef',
    }
    const rt = runtime(OK_RECORDS, { env })
    const result = await rt.turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('success')
    const keys = Object.keys(rt.calls[0]?.options.env ?? {})
    expect(keys).toEqual(expect.arrayContaining(['PATH', 'HOME', 'LANG']))
    expect(keys.filter((k) => /^(WEBTERM_|NODETERM_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH|MY_CAP)/.test(k))).toEqual([])
  })

  it('locks the SDK options down: no built-in tools, webterm MCP only, deny-by-default, no settings, never a bypass', async () => {
    const prompt = 'unique-prompt-marker-31337 $(id); rm -rf /'
    const { events, emit } = recorder()
    const rt = runtime()
    await rt.turn(turnInput({ text: prompt }), emit)
    const { options, message, text } = rt.calls[0] as FakeCall

    expect(text).toBe(prompt)
    expect(message?.message.content).toBe(prompt)
    expect(JSON.stringify(options)).not.toContain('unique-prompt-marker')
    expect(options).toMatchObject({
      tools: [], strictMcpConfig: true, allowedTools: ['mcp__webterm__*'], permissionMode: 'dontAsk', permissionPrompts: 'none',
      settingSources: [], includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: expect.stringContaining('webterm Central') },
    })
    expect(options.extraArgs).toEqual({ 'mcp-config': expect.stringMatching(/\.mcp\.json$/), 'disable-slash-commands': null })
    expect(options.mcpServers).toBeUndefined()
    expect(options.canUseTool).toBeUndefined()
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(JSON.stringify(options)).not.toContain('bypassPermissions')
    expect(JSON.stringify(events)).not.toContain('unique-prompt-marker')
  })

  it('runs Claude through the launch profile hook, never the bundled binary', async () => {
    const rt = runtime(OK_RECORDS, { executable: '/opt/test-only/claude' })
    await rt.turn(turnInput(), recorder().emit)
    const { options } = rt.calls[0] as FakeCall
    expect(options.pathToClaudeCodeExecutable).toBe('/opt/test-only/claude')
    expect(typeof options.spawnClaudeCodeProcess).toBe('function')
    expect(options.stderr).toBeUndefined()
  })

  it('hands Claude a 0600 webterm-only MCP config whose token lives in a header file, removed after the turn', async () => {
    type Seen = { cfg: string; servers: string[]; args: string[]; cfgMode: number; headers: string; headerMode: number; header: string }
    const box: { seen?: Seen } = {}
    const play = (call: FakeCall) => {
      const cfg = String(call.options.extraArgs?.['mcp-config'])
      const mcp = JSON.parse(readFileSync(cfg, 'utf8')) as { mcpServers: Record<string, { args: string[] }> }
      const args = mcp.mcpServers.webterm?.args ?? []
      const headers = args[args.indexOf('--headers') + 1] as string
      box.seen = { cfg, servers: Object.keys(mcp.mcpServers), args, cfgMode: statSync(cfg).mode & 0o777,
        headers, headerMode: statSync(headers).mode & 0o777, header: readFileSync(headers, 'utf8') }
      return OK_RECORDS
    }
    const minted: string[] = []
    const revoked: string[] = []
    const mcp = createCentralMcpLink({ dir: join(dir, 'mcp'), port: 4567, mint: (conversationId) => { minted.push(conversationId); return { token: 'wcap_test-only', revoke: () => revoked.push(conversationId) } } })
    const result = await runtime(play, { mcp }).turn(turnInput({ conversationId: 'central:project:p1' }), recorder().emit)
    expect(result.outcome).toBe('success')
    const s = box.seen as Seen
    expect(s.servers).toEqual(['webterm'])
    expect(s.args.join(' ')).not.toContain('wcap_')
    expect(s.args[s.args.indexOf('--port') + 1]).toBe('4567')
    expect(s.header).toBe('x-webterm-capability: wcap_test-only\n')
    expect([s.cfgMode, s.headerMode]).toEqual([0o600, 0o600])
    expect(minted).toEqual(['central:project:p1'])
    expect(revoked).toEqual(['central:project:p1'])
    expect(existsSync(s.cfg) || existsSync(s.headers)).toBe(false)
  })

  it('fails the turn without starting Claude when the MCP wiring cannot be written', async () => {
    const mcp = { open: async () => { throw new Error('disk full') } }
    const { events, emit } = recorder()
    const rt = runtime(OK_RECORDS, { mcp })
    const result = await rt.turn(turnInput(), emit)
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'runtime_error' })
    expect(rt.calls).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(['error', 'usage', 'turn.result'])
  })

  it('runs in an empty 0700 work dir created for the child', async () => {
    const rt = runtime()
    await rt.turn(turnInput(), recorder().emit)
    const work = join(dir, 'work')
    expect(rt.calls[0]?.options.cwd).toBe(work)
    expect(statSync(work).mode & 0o777).toBe(0o700)
  })

  it('forwards an alias model, drops provider/model, and sends the budget cap', async () => {
    const a = runtime(OK_RECORDS, { model: 'sonnet' })
    await a.turn(turnInput({ limits: { maxCostMicros: 500_000 } }), recorder().emit)
    expect(a.calls[0]?.options.model).toBe('sonnet')
    expect(a.calls[0]?.options.maxBudgetUsd).toBe(0.5)
    expect(a.calls[0]?.options.maxTurns).toBe(8)

    const b = runtime(OK_RECORDS, { model: 'opencode/deepseek-v4.1-flash-free' })
    await b.turn(turnInput({ turnId: 't2', limits: { maxTurns: 3 } }), recorder().emit)
    expect(b.calls[0]?.options.model).toBeUndefined()
    expect(b.calls[0]?.options.maxBudgetUsd).toBeUndefined()
    expect(b.calls[0]?.options.maxTurns).toBe(3)
  })

  it('never reads the model from provider-style env when none is configured', async () => {
    const rt = runtime()
    await rt.turn(turnInput(), recorder().emit)
    expect(rt.calls[0]?.options.model).toBeUndefined()
  })
})

describe('ClaudeRuntime preflight', () => {

  it.each([
    ['claude_not_found', 'Claude Code is not installed on the server PATH'],
    ['claude_not_authenticated', 'Claude Code is not signed in: run "claude auth login" on the server machine'],
    ['claude_check_failed', 'Claude Code could not be checked'],
  ] as const)('%s fails the turn without spawning', async (code, message) => {
    const preflight = async (): Promise<ClaudeReady> => ({ ok: false, code, hint: 'ignored' })
    const { events, emit } = recorder()
    const rt = runtime(OK_RECORDS, { preflight })
    const result = await rt.turn(turnInput(), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(events.map((e) => e.type)).toEqual(['error', 'usage', 'turn.result'])
    expect(events[0]).toMatchObject({ type: 'error', code: 'runtime_unavailable', message, retryable: false })
    expect(rt.calls).toHaveLength(0)
  })

  it('treats a throwing preflight as "could not check" and does not start Claude', async () => {
    const preflight = async (): Promise<ClaudeReady> => { throw new Error('boom with secret-detail') }
    const { events, emit } = recorder()
    const rt = runtime(OK_RECORDS, { preflight })
    const result = await rt.turn(turnInput(), emit)
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(JSON.stringify(events)).not.toContain('secret-detail')
    expect(rt.calls).toHaveLength(0)
  })

  it('starts Claude normally when the preflight is ok', async () => {
    const rt = runtime(OK_RECORDS, { preflight: async () => ({ ok: true }) })
    const result = await rt.turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('success')
    expect(rt.calls).toHaveLength(1)
  })
})
