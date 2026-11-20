// Staged Test connection with an injected process runner (no real claude, no network): stage order,
// skipped stages, the request's failure table, argv shape, no secret in any event, cost booked.
import { describe, expect, it, vi } from 'vitest'
import { resolveProfileLaunch } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import type { RunFn, RunResult } from '../claudeLauncher/claudeLaunch.probe'
import { setProxyEndpointSource } from '../credentialProxy/credentialProxy.env'
import { classifyRequestFailure, CONN_TEXT, CONNECTION_TEST_PROMPT, requestArgv, runConnectionTest, type ConnEvent, type RequestFailure } from './claudeProvider.connectionTest'

await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  process.env.WEBTERM_DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/wt-conn-data-`)
})

const LEAK = 'sk-ant-api03-LEAKLEAKLEAKLEAK1234' // test-only
const launch = (command: string) => resolveProfileLaunch({ claudeLaunchProfiles: [{ id: 'p', name: 'P', command }], defaultClaudeProfileId: 'p', centralClaudeProfileId: '' })
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const SUCCESS = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.0012, usage: { input_tokens: 12, output_tokens: 2 }, modelUsage: { 'claude-haiku-4-5': { costUSD: 0.0012 } } })
const apiError = (text: string): RunResult => ({ code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text }), stderr: '', timedOut: false })

/** Fake runner: answers `--version`, `auth status` and the `-p` request; records every argv. */
function runner(request: RunResult | 'throw' = ok(SUCCESS), auth: RunResult = ok('{"loggedIn":true,"authMethod":"claude.ai"}')) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = []
  const run: RunFn = async (cmd, args, o) => {
    calls.push({ cmd, args, ...(o.cwd ? { cwd: o.cwd } : {}) })
    if (args.includes('--version')) return ok('2.1.318 (Claude Code)')
    if (args.includes('auth')) return auth
    if (request === 'throw') throw new Error('spawn failed: ENOENT')
    return request
  }
  return { calls, run }
}

async function test(command: string, r = runner(), extra: { mode?: string; ready?: boolean; env?: NodeJS.ProcessEnv; book?: (k: string, u: unknown) => void; sendRequest?: boolean } = {}) {
  const events: ConnEvent[] = []
  let t = 0
  const final = await runConnectionTest(launch(command), {
    env: extra.env ?? { PATH: '/bin' }, provider: { mode: extra.mode ?? 'login', ready: extra.ready ?? true }, run: r.run, onPath: () => true,
    book: extra.book ?? (() => undefined), now: () => (t += 100), ...(extra.sendRequest === false ? { sendRequest: false } : {}),
  }, (e) => events.push(e))
  const stages = events.filter((e): e is Extract<ConnEvent, { stage: string; state: string }> => 'state' in e).map((e) => `${e.stage}:${e.state}`)
  return { events, final, stages, calls: r.calls }
}

describe('runConnectionTest', () => {
  it('login, no wrapper: wrapper skipped, then cli -> auth -> request, each running then ok; final names the model and the path', async () => {
    const book = vi.fn()
    const { events, final, stages, calls } = await test('claude', runner(), { book })
    expect(stages).toEqual(['wrapper:skipped', 'cli:running', 'cli:ok', 'auth:running', 'auth:ok', 'request:running', 'request:ok'])
    expect(events.find((e) => 'state' in e && e.stage === 'cli' && e.state === 'ok')).toMatchObject({ detail: 'claude 2.1.318 (Claude Code)', ms: expect.any(Number) })
    expect(events.find((e) => 'state' in e && e.stage === 'request' && e.state === 'ok')).toMatchObject({ detail: CONN_TEXT.answered('claude-haiku-4-5', 100) })
    expect(final).toMatchObject({ result: 'ok', model: 'claude-haiku-4-5', via: 'Claude Code login', summary: 'Connection works — Claude answered in 0.1 s via Claude Code login' })
    expect(events[events.length - 1]).toEqual(final)
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['--version', 'auth status', '-p --output-format'])
    expect(book).toHaveBeenCalledWith('connection_test', { input: 12, output: 2, cacheRead: 0, cacheWrite: 0, costMicros: 1200, model: 'claude-haiku-4-5' })
  })

  it('without the request (wizard on open): request is pending, the result is "ready", nothing is sent or booked', async () => {
    const book = vi.fn()
    const { events, final, stages, calls } = await test('claude', runner(), { book, sendRequest: false })
    expect(stages).toEqual(['wrapper:skipped', 'cli:running', 'cli:ok', 'auth:running', 'auth:ok', 'request:pending'])
    expect(events.find((e) => 'state' in e && e.state === 'pending')).toMatchObject({ detail: CONN_TEXT.notTested })
    expect(final).toMatchObject({ result: 'ready', summary: CONN_TEXT.ready })
    expect(final.summary).not.toMatch(/works/)
    expect(calls.some((c) => c.args.includes('-p'))).toBe(false)
    expect(book).not.toHaveBeenCalled()
    // A failure before the request is still a failure.
    const r = runner(ok(SUCCESS), { code: 1, stdout: '{"loggedIn":false}', stderr: '', timedOut: false })
    expect((await test('claude', r, { sendRequest: false })).stages.slice(-1)).toEqual(['request:skipped'])
  })

  it('the request argv: launch argv + the helpers\' isolation flags, cheapest tier, one turn, fixed tmp cwd', async () => {
    const { calls } = await test('claude --verbose')
    const req = calls[calls.length - 1]!
    expect([req.cmd, ...req.args]).toEqual(['claude', '--verbose', '-p', '--output-format', 'json', '--model', 'haiku', '--effort', 'low', '--tools', '',
      '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1', '--max-budget-usd', '0.05', CONNECTION_TEST_PROMPT])
    expect(req.cwd).toBeTruthy()
  })

  it('the model honours the provider precedence (modelRequest): tier var keeps the alias, ANTHROPIC_MODEL alone drops --model', () => {
    const l = launch('claude')
    expect(requestArgv(l, { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw-small' })).toMatchObject({ requested: 'gw-small', argv: expect.arrayContaining(['--model', 'haiku']) })
    const main = requestArgv(l, { ANTHROPIC_MODEL: 'gw-main' })
    expect(main.requested).toBe('gw-main')
    expect(main.argv).not.toContain('--model')
  })

  it('a wrapper runs first and names the path; key modes check the credential without `auth status`', async () => {
    const { stages, final, calls } = await test('envman -e x -- claude', runner(), { mode: 'apiKey' })
    expect(stages).toEqual(['wrapper:running', 'wrapper:ok', 'cli:running', 'cli:ok', 'auth:running', 'auth:ok', 'request:running', 'request:ok'])
    expect(final.via).toBe('envman')
    expect(calls.some((c) => c.args.includes('auth'))).toBe(false)
    expect(calls.every((c) => c.cmd === 'envman')).toBe(true)
  })

  it('a failed stage stops the test: the later stages are skipped and no request is sent', async () => {
    const r = runner(ok(SUCCESS), { code: 1, stdout: '{"loggedIn":false}', stderr: '', timedOut: false })
    const { stages, final, calls } = await test('claude', r)
    expect(stages).toEqual(['wrapper:skipped', 'cli:running', 'cli:ok', 'auth:running', 'auth:failed', 'request:skipped'])
    expect(final).toMatchObject({ result: 'failed', stage: 'auth', failed: 'auth_failed', summary: 'Failed at Sign-in: Claude Code is not signed in.' })
    expect(calls.some((c) => c.args.includes('-p'))).toBe(false)
    const keyless = await test('claude', runner(), { mode: 'apiKey', ready: false })
    expect(keyless.stages.slice(-2)).toEqual(['auth:failed', 'request:skipped'])
  })

  it.each<[string, RunResult | 'throw', RequestFailure]>([
    ['401', apiError(`API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ${LEAK}"}}`), 'auth_rejected'],
    ['403', apiError('API Error: 403 {"error":{"type":"permission_error","message":"Request not allowed"}}'), 'auth_rejected'],
    ['404', apiError('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-haiku-9"}}'), 'model_not_found'],
    ['429', apiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), 'rate_limited'],
    ['ENOTFOUND', { code: 1, stdout: '', stderr: `API Error: Connection error. getaddrinfo ENOTFOUND gw.invalid ${LEAK}`, timedOut: false }, 'network'],
    ['502', apiError('API Error: 502 Bad Gateway'), 'proxy_error'],
    ['timeout', { code: null, stdout: '', stderr: '', timedOut: true }, 'timeout'],
    ['non-JSON exit', { code: 3, stdout: `boom ${LEAK}`, stderr: '', timedOut: false }, 'request_failed'],
    ['spawn error', 'throw', 'request_failed'],
  ])('%s -> %s, with the fixed message and hint only', async (_name, request, failed) => {
    const { events, final, stages } = await test('claude', runner(request))
    expect(stages.slice(-2)).toEqual(['request:running', 'request:failed'])
    const [detail, hint] = CONN_TEXT.request[failed]
    expect(events.find((e) => 'state' in e && e.state === 'failed')).toMatchObject({ stage: 'request', detail, hint })
    expect(final).toMatchObject({ result: 'failed', stage: 'request', failed, summary: CONN_TEXT.failedAt('request', detail) })
    expect(JSON.stringify(events)).not.toContain(LEAK)
    expect(JSON.stringify(events)).not.toContain('boom')
  })

  it('the failure table matches plain CLI texts too', () => {
    expect(classifyRequestFailure('Invalid API key · Please run /login', false)).toBe('auth_rejected')
    expect(classifyRequestFailure('There\'s an issue with the selected model (x). It may not exist', false)).toBe('model_not_found')
    expect(classifyRequestFailure('connect ECONNREFUSED 127.0.0.1:4000', false)).toBe('network')
    expect(classifyRequestFailure('anything', true)).toBe('timeout')
    expect(classifyRequestFailure('', false)).toBe('request_failed')
  })

  it('the credential proxy codes are classified before the generic status rows', () => {
    const msg = (code: string, status: number) => `API Error: ${status} {"type":"error","error":{"type":"api_error","message":"webterm credential proxy: ${code}"}}`
    expect(classifyRequestFailure(msg('bad_proxy_token', 401), false)).toBe('request_failed')
    expect(classifyRequestFailure(msg('no_upstream', 503), false)).toBe('request_failed')
    expect(classifyRequestFailure(msg('upstream_unreachable', 502), false)).toBe('network')
    expect(classifyRequestFailure(msg('upstream_timeout', 504), false)).toBe('timeout')
  })

  it('a proxy token / no-upstream failure shows its own hint; the auth stage says it went via the proxy', async () => {
    setProxyEndpointSource(() => ({ url: 'http://127.0.0.1:5555', token: 'placeholder' }))
    try {
      const env = { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555' }
      const bad = await test('claude', runner(apiError('API Error: 401 webterm credential proxy: bad_proxy_token')), { mode: 'apiKey', env })
      expect(bad.events.find((e) => 'state' in e && e.state === 'failed')).toMatchObject({ stage: 'request', hint: 'Restart the Claude session.' })
      const none = await test('claude', runner(apiError('API Error: 503 webterm credential proxy: no_upstream')), { mode: 'apiKey', env })
      expect(none.events.find((e) => 'state' in e && e.state === 'failed')).toMatchObject({ hint: 'Save a provider key in Settings.' })
      expect(bad.events.find((e) => 'stage' in e && e.stage === 'auth' && 'state' in e && e.state === 'ok')).toMatchObject({ detail: expect.stringContaining(CONN_TEXT.viaProxy) })
    } finally { setProxyEndpointSource(() => null) }
  })

  it('a booking failure never fails the test', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { final } = await test('claude', runner(), { book: () => { throw new Error('db locked') } })
    expect(final.result).toBe('ok')
  })
})
