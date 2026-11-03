import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntime } from './claudeRuntime'
import type { ClaudeReady, ClaudeRuntimeOptions } from './claudeOptions'
import { captureSource, emitSource, initRecord, recorder, resultRecord, turnInput, writeFakeClaude } from './claude.fakeBin'

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
    killGraceMs: 50, ...extra,
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
      '-p', '--strict-mcp-config', '--safe-mode', '--include-partial-messages',
    ]))
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none')
    const joined = argv.join(' ')
    expect(joined).not.toContain('bypassPermissions')
    expect(joined).not.toContain('--dangerously-skip-permissions')
    expect(JSON.stringify(events)).not.toContain('unique-prompt-marker')
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
    ['claude_not_found', 'Claude Code belum terpasang di PATH server'],
    ['claude_not_authenticated', 'Claude Code belum login: jalankan "claude auth login" di mesin server'],
    ['claude_check_failed', 'Claude Code tidak dapat dicek'],
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
