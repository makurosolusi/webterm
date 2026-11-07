import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntime } from './claudeRuntime'
import type { ClaudeReady, ClaudeRuntimeOptions } from './claudeOptions'
import { captureSource, emitSource, initRecord, recorder, resultRecord, turnInput, writeFakeClaude } from './claude.fakeBin'
import { createCentralMcpLink } from './claudeMcp'
import { logBus } from '../../logs'

let dir = ''
let capture = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-safety-'))
  capture = join(dir, 'capture.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const OK_RECORDS = [initRecord(), resultRecord()]
const capturing = () => writeFakeClaude(dir, `${captureSource(capture)}${emitSource(OK_RECORDS)}`)
const captured = () => JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; envKeys: string[]; cwd: string; stdin: string }

function runtime(executable: string, extra: Partial<ClaudeRuntimeOptions> = {}) {
  return new ClaudeRuntime({
    executable, workDir: join(dir, 'work'), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    killGraceMs: 50,
    // test-only token: keeps the process capability store (and its import graph) out of these tests
    mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }),
    ...extra,
  })
}

describe('ClaudeRuntime child isolation', () => {
  it('scrubs WEBTERM_/NODETERM_/provider/capability values from the child env', async () => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C',
      WEBTERM_TOKEN: 'root', NODETERM_NODE_ID: 'n1', NODETERM_PORT: '1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 'k', MY_CAP: 'wcap_deadbeef',
    }
    const result = await runtime(capturing(), { env }).turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('success')
    const keys = captured().envKeys
    expect(keys).toEqual(expect.arrayContaining(['PATH', 'HOME', 'LANG']))
    expect(keys.filter((k) => /^(WEBTERM_|NODETERM_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH|MY_CAP)/.test(k))).toEqual([])
  })

  it('passes the prompt on stdin only, with the locked-down flags and no bypass', async () => {
    const prompt = 'unique-prompt-marker-31337 $(id); rm -rf /'
    const { events, emit } = recorder()
    await runtime(capturing()).turn(turnInput({ text: prompt }), emit)
    const { argv, stdin } = captured()

    expect(stdin).toBe(prompt)
    expect(argv.join('\n')).not.toContain('unique-prompt-marker')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(argv).toEqual(expect.arrayContaining([
      '-p', '--strict-mcp-config', '--disable-slash-commands', '--include-partial-messages',
    ]))
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__webterm__*')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none')
    const joined = argv.join(' ')
    expect(joined).not.toContain('bypassPermissions')
    expect(joined).not.toContain('--dangerously-skip-permissions')
    expect(JSON.stringify(events)).not.toContain('unique-prompt-marker')
  })

  it('hands Claude a 0600 webterm-only MCP config whose token lives in a header file, removed after the turn', async () => {
    const body = `const a = process.argv.slice(2)
const cfg = a[a.indexOf('--mcp-config') + 1]
const mcp = JSON.parse(fs.readFileSync(cfg, 'utf8'))
const srv = mcp.mcpServers.webterm
const headers = srv.args[srv.args.indexOf('--headers') + 1]
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cfg, servers: Object.keys(mcp.mcpServers), args: srv.args, cfgMode: fs.statSync(cfg).mode & 0o777,
  headers, headerMode: fs.statSync(headers).mode & 0o777, header: fs.readFileSync(headers, 'utf8') }))
${emitSource(OK_RECORDS)}`
    const minted: string[] = []
    const revoked: string[] = []
    const mcp = createCentralMcpLink({ dir: join(dir, 'mcp'), port: 4567, mint: (conversationId) => { minted.push(conversationId); return { token: 'wcap_test-only', revoke: () => revoked.push(conversationId) } } })
    const result = await runtime(writeFakeClaude(dir, body), { mcp }).turn(turnInput({ conversationId: 'central:project:p1' }), recorder().emit)
    expect(result.outcome).toBe('success')
    const seen = JSON.parse(readFileSync(capture, 'utf8')) as { cfg: string; servers: string[]; args: string[]; cfgMode: number; headers: string; headerMode: number; header: string }
    expect(seen.servers).toEqual(['webterm'])
    expect(seen.args.join(' ')).not.toContain('wcap_')
    expect(seen.args[seen.args.indexOf('--port') + 1]).toBe('4567')
    expect(seen.header).toBe('x-webterm-capability: wcap_test-only\n')
    expect([seen.cfgMode, seen.headerMode]).toEqual([0o600, 0o600])
    expect(minted).toEqual(['central:project:p1'])
    expect(revoked).toEqual(['central:project:p1'])
    expect(existsSync(seen.cfg) || existsSync(seen.headers)).toBe(false)
  })

  it('fails the turn without spawning when the MCP wiring cannot be written', async () => {
    const mcp = { open: async () => { throw new Error('disk full') } }
    const { events, emit } = recorder()
    const result = await runtime(capturing(), { mcp }).turn(turnInput(), emit)
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'runtime_error' })
    expect(existsSync(capture)).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['error', 'usage', 'turn.result'])
  })

  it('runs in an empty 0700 work dir created for the child', async () => {
    await runtime(capturing()).turn(turnInput(), recorder().emit)
    const work = join(dir, 'work')
    expect(captured().cwd).toBe(realpathSync(work))
    expect(statSync(work).mode & 0o777).toBe(0o700)
  })

  it('forwards an alias model, drops provider/model, and sends the budget cap', async () => {
    await runtime(capturing(), { model: 'sonnet' }).turn(turnInput({ limits: { maxCostMicros: 500_000 } }), recorder().emit)
    let argv = captured().argv
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('0.5')

    await runtime(capturing(), { model: 'opencode/deepseek-v4.1-flash-free' }).turn(turnInput({ turnId: 't2' }), recorder().emit)
    argv = captured().argv
    expect(argv).not.toContain('--model')
    expect(argv).not.toContain('--max-budget-usd')
  })

  it('never reads the model from provider-style env when none is configured', async () => {
    await runtime(capturing()).turn(turnInput(), recorder().emit)
    expect(captured().argv).not.toContain('--model')
  })
})

describe('ClaudeRuntime preflight', () => {
  const marker = () => join(dir, 'spawned')
  const spawning = () => writeFakeClaude(dir, `fs.writeFileSync(${JSON.stringify(marker())}, '1')\n${emitSource(OK_RECORDS)}`)

  it.each([
    ['claude_not_found', 'Claude Code is not installed on the server PATH'],
    ['claude_not_authenticated', 'Claude Code is not signed in: run "claude auth login" on the server machine'],
    ['claude_check_failed', 'Claude Code could not be checked'],
  ] as const)('%s fails the turn without spawning', async (code, message) => {
    const preflight = async (): Promise<ClaudeReady> => ({ ok: false, code, hint: 'ignored' })
    const { events, emit } = recorder()
    const result = await runtime(spawning(), { preflight }).turn(turnInput(), emit)

    expect(result.outcome).toBe('error')
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(events.map((e) => e.type)).toEqual(['error', 'usage', 'turn.result'])
    expect(events[0]).toMatchObject({ type: 'error', code: 'runtime_unavailable', message, retryable: false })
    expect(existsSync(marker())).toBe(false)
  })

  it('treats a throwing preflight as "could not check" and does not spawn', async () => {
    const preflight = async (): Promise<ClaudeReady> => { throw new Error('boom with secret-detail') }
    const { events, emit } = recorder()
    const result = await runtime(spawning(), { preflight }).turn(turnInput(), emit)
    expect(result.errorCode).toBe('runtime_unavailable')
    expect(JSON.stringify(events)).not.toContain('secret-detail')
    expect(existsSync(marker())).toBe(false)
  })

  it('spawns normally when the preflight is ok', async () => {
    const result = await runtime(spawning(), { preflight: async () => ({ ok: true }) }).turn(turnInput(), recorder().emit)
    expect(result.outcome).toBe('success')
    expect(existsSync(marker())).toBe(true)
  })
})

describe('ClaudeRuntime child exit without a result', () => {
  it('surfaces the exit status and redacted stderr line in the error event and logs it', async () => {
    const exe = writeFakeClaude(dir, `readStdin(); process.stderr.write('warming up\\nError: profile "p" not found in envman sk-ant-abcdefghijklmnopqrstu\\n'); process.exit(3)`)
    const before = logBus.query({}).length
    const { events, emit } = recorder()
    const result = await runtime(exe).turn(turnInput({ turnId: 't-exit' }), emit)
    expect(result).toMatchObject({ outcome: 'error', errorCode: 'runtime_error' })
    const error = events.find((e) => e.type === 'error') as { message: string } | undefined
    expect(error?.message).toBe('Claude exited with code 3 before starting: Error: profile "p" not found in envman [redacted]')
    const logged = logBus.query({}).slice(before).find((e) => e.event === 'central.turn.failed')
    expect(logged?.level).toBe('error')
    expect(logged?.data).toMatchObject({ turnId: 't-exit', exitCode: 3 })
    expect(JSON.stringify(logged)).not.toContain('sk-ant-abcdef')
  })

  it('falls back to the exit status when stderr is empty', async () => {
    const { events, emit } = recorder()
    await runtime(writeFakeClaude(dir, 'readStdin(); process.exit(7)')).turn(turnInput(), emit)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'Claude exited with code 7 before starting' })
  })
})
