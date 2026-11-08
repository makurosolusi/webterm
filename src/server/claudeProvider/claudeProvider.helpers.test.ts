// Every Claude spawn path uses the saved provider: Central runtime, the headless `claude -p` helpers
// (classifier, structured summaries, planner, names), agent PTY sessions and the readiness preflight.
// Real child processes against a fake `claude` that reports only lengths/flags, never the key itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveProvider } from './claudeProvider.store'
import { writeFakeClaude, recorder, turnInput } from '../central/runtime/claude.fakeBin'
import { fakeQuery } from '../central/runtime/claude.fakeQuery'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
let dir = ''
let prev: string | undefined

const spawnRecord = vi.hoisted(() => ({ req: undefined as unknown }))
vi.mock('../spawn/agentSpawn', async (orig) => ({
  ...(await orig<typeof import('../spawn/agentSpawn')>()),
  spawnAgent: async (req: unknown) => { spawnRecord.req = req; return { ok: false, code: 'test', message: 'test-only' } },
}))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-helpers-'))
  prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  saveProvider({ mode: 'custom', baseUrl: 'https://gw.example.test', credential: 'authToken' }, KEY)
})
afterEach(() => {
  process.env.WEBTERM_DATA_DIR = prev
  rmSync(dir, { recursive: true, force: true })
})

/** Fake claude writing what it saw to `out`, then failing (callers only need to have spawned it). */
function reporter(out: string): string {
  return writeFakeClaude(dir, `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    tokenLen: (process.env.ANTHROPIC_AUTH_TOKEN || '').length, baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
    apiKey: 'ANTHROPIC_API_KEY' in process.env, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null,
    keyInArgv: process.argv.join(' ').includes(${JSON.stringify(KEY)}),
  }))
try { readStdin() } catch {}
process.exit(1)`)
}
const seen = (out: string) => JSON.parse(readFileSync(out, 'utf8'))
const EXPECTED = { tokenLen: KEY.length, baseUrl: 'https://gw.example.test', apiKey: false, scrub: '1', keyInArgv: false }

describe('claudeEnv() reaches every Claude process', () => {
  it('Central runtime', async () => {
    const { ClaudeRuntime } = await import('../central/runtime/claudeRuntime')
    const { createCentralMcpLink } = await import('../central/runtime/claudeMcp')
    const fake = fakeQuery([])
    await new ClaudeRuntime({
      query: fake.query, workDir: join(dir, 'work'), newSessionId: () => 'sid',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: 'inherited-test-only' },
      mcp: createCentralMcpLink({ dir: join(dir, 'mcp'), port: 1, mint: () => ({ token: 'wcap_test-only', revoke: () => undefined }) }), // test-only
    }).turn(turnInput(), recorder().emit)
    // The SDK `env` option is the child's whole environment; nothing else carries the key.
    const options = fake.calls[0]?.options ?? {}
    const env = options.env ?? {}
    const { env: _env, ...rest } = options
    expect({
      tokenLen: (env.ANTHROPIC_AUTH_TOKEN || '').length, baseUrl: env.ANTHROPIC_BASE_URL ?? null, apiKey: 'ANTHROPIC_API_KEY' in env,
      scrub: env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null, keyInArgv: JSON.stringify(rest).includes(KEY),
    }).toEqual(EXPECTED)
  })

  it('policy classifier and structured summaries (claude -p)', async () => {
    const { createClaudeClassifier } = await import('../policy/policy.classifier.claude')
    const { createClaudeStructured } = await import('../central/context/claudeStructured')
    const a = join(dir, 'classifier.json')
    const b = join(dir, 'structured.json')
    await createClaudeClassifier({ bin: reporter(a) })({ tool: 'Bash', input: {} } as never, new AbortController().signal).catch(() => undefined)
    await createClaudeStructured('brief', { bin: reporter(b) })({ prompt: 'x', schema: {} }, new AbortController().signal).catch(() => undefined)
    expect(seen(a)).toEqual(EXPECTED)
    expect(seen(b)).toEqual(EXPECTED)
  })

  it('name generation env', async () => {
    const { cleanEnv } = await import('../nameGen')
    const env = cleanEnv()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.test')
    expect(env.TERM).toBe('xterm-256color')
  })

  it('DAG planner: sends no env or overrides of its own (agentSpawn applies the provider)', async () => {
    const { livePlanner } = await import('../dag/dag.planner')
    await livePlanner({ intent: 'x', repo: dir } as never).catch(() => undefined)
    const h = (spawnRecord.req as { headless: { overrides?: Record<string, string>; env?: Record<string, string>; argv: string[] } }).headless
    expect(h.env).toBeUndefined()
    expect(h.overrides).toBeUndefined()
    expect(h.argv.join(' ')).not.toContain(KEY)
  })

  it('agent PTY session: key only in the one-shot file, never in cmd or the spawn env', async () => {
    const { Sessions } = await import('../sessions')
    const { FakePty } = await import('../fakePty.testutil')
    const spawns: { cmd?: string; env?: Record<string, string> }[] = []
    const s = new Sessions({ spawn: (o) => { spawns.push(o); return new FakePty(1) } })
    s.open({ t: 'open', id: 'agent-cp', cols: 80, rows: 24, agentId: 'claude', cmd: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' }, () => {})
    s.open({ t: 'open', id: 'shell-cp', cols: 80, rows: 24, cmd: 'ls' }, () => {})
    expect(spawns[0]!.cmd).toMatch(/^\/bin\/sh '.+\.sh'$/)
    expect(JSON.stringify(spawns)).not.toContain(KEY)
    expect(spawns[1]!.cmd).toBe('ls') // plain terminals are never touched
    const launchDir = join(dir, 'data', 'claude-provider', 'launch')
    const script = readFileSync(join(launchDir, readdirSync(launchDir)[0]!), 'utf8')
    expect(script).toContain('export ANTHROPIC_AUTH_TOKEN=')
    expect(script).toContain('unset ANTHROPIC_API_KEY')
    expect(s.claudeSessionsStartedBefore(Date.now() + 1)).toBe(1)
    s.close('agent-cp'); s.close('shell-cp')
  })

  it('login mode: agent command untouched', async () => {
    saveProvider({ mode: 'login' }, null)
    const { Sessions } = await import('../sessions')
    const { FakePty } = await import('../fakePty.testutil')
    const spawns: { cmd?: string }[] = []
    const s = new Sessions({ spawn: (o) => { spawns.push(o); return new FakePty(1) } })
    s.open({ t: 'open', id: 'agent-login', cols: 80, rows: 24, agentId: 'claude', cmd: 'claude', sessionId: '22222222-2222-4222-8222-222222222222' }, () => {})
    expect(spawns[0]!.cmd).toMatch(/^claude /)
    s.close('agent-login')
  })

  it('readiness preflight: a ready key provider skips `claude auth status`, a missing key is not ready', async () => {
    const { createClaudePreflight } = await import('../central/runtime/claudePreflight')
    const run = vi.fn(async () => ({ code: 0, stdout: '{"loggedIn":true}', timedOut: false }))
    const base = { env: {}, onPath: () => true, run }
    expect(await createClaudePreflight({ ...base, provider: () => ({ mode: 'custom', ready: true }) })()).toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
    expect(await createClaudePreflight({ ...base, provider: () => ({ mode: 'apiKey', ready: false }) })()).toMatchObject({ ok: false, code: 'claude_not_authenticated' })
    expect(await createClaudePreflight({ ...base, provider: () => ({ mode: 'login', ready: true }) })()).toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
