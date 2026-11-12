// Command mode end to end through the API with REAL child processes: fake `claude` scripts, no network,
// no real claude/envman. The fake prints secret-looking text so every case also proves it never leaks.
// POST /test is the NDJSON Test connection stream (claudeProvider.connectionStream.ts).
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleProviderApi, lastProviderTest, PROVIDER_PATH, type ProviderApiDeps } from './claudeProvider.api'
import type { ProviderTestDeps } from './claudeProvider.connectionStream'
import { postTest, uiPost } from './claudeProvider.connectionStream.testutil'
import type { ConnEvent, FinalEvent } from './claudeProvider.connectionTest'
import { registerClaudeLaunchSettings } from '../claudeLauncher/claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const LEAK = 'sk-ant-LEAKLEAKLEAKLEAK1234' // test-only
const FAKE = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case " $* " in *" --version "*) [ "$FAKE_MODE" = verfail ] && { echo "boom ${LEAK}" >&2; exit 3; }; echo 2.1.0; exit 0 ;; esac
[ "$1" = auth ] && { echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; }
case "$FAKE_MODE" in
  nonjson) echo "not json ${LEAK}"; exit 0 ;;
  e401) echo '{"type":"result","is_error":true,"result":"API Error: 401 invalid x-api-key ${LEAK}"}'; exit 1 ;;
  e404) echo '{"type":"result","is_error":true,"result":"API Error: 404 not_found_error model ${LEAK}"}'; exit 1 ;;
  e429) echo '{"type":"result","is_error":true,"result":"API Error: 429 rate_limit_error ${LEAK}"}'; exit 1 ;;
  dns) echo "getaddrinfo ENOTFOUND gw.invalid ${LEAK}" >&2; exit 1 ;;
  hang) sleep 5; exit 0 ;;
  slow) sleep 0.3 ;;
esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"${LEAK}","total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":1},"modelUsage":{"claude-haiku-4-5":{"costUSD":0.001}}}'
`
let dir = ''
let prev: string | undefined
let log = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-cmd-'))
  prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
  log = join(dir, 'log')
  writeFileSync(join(dir, 'claude'), FAKE)
  chmodSync(join(dir, 'claude'), 0o755)
  setProfiles([{ id: 'p', name: 'Mine', command: `${join(dir, 'claude')} --model opus` }])
})
afterEach(() => {
  process.env.WEBTERM_DATA_DIR = prev
  registerClaudeLaunchSettings(() => DEFAULT_SETTINGS)
  rmSync(dir, { recursive: true, force: true })
})

const setProfiles = (claudeLaunchProfiles: { id: string; name: string; command: string }[]): void =>
  registerClaudeLaunchSettings(() => ({ ...DEFAULT_SETTINGS, claudeLaunchProfiles }))

const ui = (method: string): IncomingMessage =>
  ({ method, headers: { host: 'localhost:8700', origin: 'http://localhost:8700', 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE } }) as unknown as IncomingMessage
const deps = (mode = 'ok', extra: Partial<ProviderApiDeps> = {}): ProviderApiDeps => ({
  isNodeToken: () => false, sessionsBefore: () => 0, now: () => 1000,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: mode, FAKE_LOG: log }, ...extra,
})
const url = (p = PROVIDER_PATH) => new URL(`http://localhost:8700${p}`)
const put = (body: unknown) => handleProviderApi(ui('PUT'), url(), JSON.stringify(body), deps())
const testDeps = (mode: string, extra: Partial<ProviderTestDeps> = {}): ProviderTestDeps => ({
  isNodeToken: () => false, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: mode, FAKE_LOG: log }, book: () => undefined, ...extra,
})
const test = async (mode = 'ok', extra: Partial<ProviderTestDeps> = {}, body?: unknown) => {
  const call = postTest(testDeps(mode, extra), uiPost(body))
  await call.done
  const final = call.events[call.events.length - 1] as FinalEvent
  const failed = call.events.find((e): e is Extract<ConnEvent, { state: string }> => 'state' in e && e.state === 'failed')
  return { call, final, failed }
}
const logLines = (): string[] => { try { return readFileSync(log, 'utf8').trim().split('\n') } catch { return [] } } // no file = nothing ran

describe('PUT / GET command mode', () => {
  it('saves only the profile id, resolves it in the view, ignores credential fields and keeps a stored secret', async () => {
    await put({ mode: 'apiKey', secret: 'sk-test-only-0123456789' }) // test-only
    const r = await put({ mode: 'command', profileId: 'p', baseUrl: 'https://x.test', secret: 'ignored-test-only-1', model: 'm' })
    expect(r.status).toBe(200)
    expect((r.body as { provider: unknown }).provider).toEqual({
      mode: 'command', profileId: 'p', updatedAt: 1000, secretSet: true, ready: true,
      profile: { id: 'p', name: 'Mine', command: `${join(dir, 'claude')} --model opus` },
    })
    const get = await handleProviderApi(ui('GET'), url(), '', deps())
    expect(JSON.stringify(get.body)).not.toContain('sk-test-only')
    expect(JSON.stringify(get.body)).not.toContain('baseUrl')
  })

  it('profileId is required, bounded and a string; the body is never echoed', async () => {
    for (const body of [{ mode: 'command' }, { mode: 'command', profileId: '' }, { mode: 'command', profileId: 7 }, { mode: 'command', profileId: 'x'.repeat(65) }]) {
      expect(await put(body)).toEqual({ status: 400, body: { error: 'invalid_profile_id' } })
    }
  })

  it('a deleted profile is profileMissing and not ready; the built-in default is a valid choice', async () => {
    await put({ mode: 'command', profileId: 'gone' })
    let p = ((await handleProviderApi(ui('GET'), url(), '', deps())).body as { provider: Record<string, unknown> }).provider
    expect(p).toMatchObject({ mode: 'command', profileId: 'gone', ready: false, profileMissing: true })
    expect(p.profile).toBeUndefined()
    await put({ mode: 'command', profileId: 'default' })
    p = ((await handleProviderApi(ui('GET'), url(), '', deps())).body as { provider: Record<string, unknown> }).provider
    expect(p).toMatchObject({ ready: true, profile: { id: 'default', command: 'claude' } })
  })

  it('warns (without echoing the value) when the command looks like it holds a secret', async () => {
    setProfiles([{ id: 's', name: 'S', command: `env ANTHROPIC_API_KEY=${LEAK} claude` }])
    const r = await put({ mode: 'command', profileId: 's' })
    expect((r.body as { provider: Record<string, unknown> }).provider).toMatchObject({ commandWarning: 'looks_like_secret' })
  })
})

describe('POST /test in command mode (NDJSON stream)', () => {
  it('ok: --version, auth status, then one -p request through the profile; streams every stage; books the cost; keeps the result', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const book = vi.fn()
    const { call, final } = await test('ok', { book })
    expect(call.status).toBe(200)
    expect(call.contentType).toBe('application/x-ndjson')
    expect(call.events.map((e) => ('state' in e ? `${e.stage}:${e.state}` : 'final'))).toEqual(
      ['wrapper:skipped', 'cli:running', 'cli:ok', 'auth:running', 'auth:ok', 'request:running', 'request:ok', 'final'])
    expect(final).toMatchObject({ result: 'ok', model: 'claude-haiku-4-5', via: 'custom command' })
    const lines = logLines()
    expect(lines.slice(0, 2)).toEqual(['--version', 'auth status'])
    expect(lines[2]).toMatch(/^--model opus -p --output-format json --model haiku .*--max-turns 1 .*Reply with OK$/)
    expect(book).toHaveBeenCalledWith('connection_test', expect.objectContaining({ model: 'claude-haiku-4-5', costMicros: 1000 }))
    expect(call.body).not.toContain(LEAK)
    expect(lastProviderTest()).toMatchObject({ ok: true, message: final.summary })
  })

  it('{ request: false } stops before the request: no -p spawn, result "ready", not kept as a test result', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const { call, final } = await test('ok', {}, { request: false })
    expect(call.events.map((e) => ('state' in e ? `${e.stage}:${e.state}` : 'final'))).toEqual(
      ['wrapper:skipped', 'cli:running', 'cli:ok', 'auth:running', 'auth:ok', 'request:pending', 'final'])
    expect(final.result).toBe('ready')
    expect(logLines()).toEqual(['--version', 'auth status'])
    expect(lastProviderTest()?.message).not.toBe(final.summary)
  })

  it('a full test never joins a running check without the request', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const quick = postTest(testDeps('slow'), uiPost({ request: false }))
    const full = postTest(testDeps('slow'))
    await Promise.all([quick.done, full.done])
    expect((full.events[full.events.length - 1] as FinalEvent).result).toBe('ok')
    expect((quick.events[quick.events.length - 1] as FinalEvent).result).toBe('ready')
  })

  it('a wrapper not on PATH fails at Wrapper, naming it; nothing later runs', async () => {
    setProfiles([{ id: 'e', name: 'E', command: 'definitely-missing-envman -e x -- claude' }])
    await put({ mode: 'command', profileId: 'e' })
    const { call, final } = await test('ok')
    expect(final).toMatchObject({ result: 'failed', stage: 'wrapper', failed: 'wrapper_not_found' })
    expect(final.summary).toBe('Failed at Wrapper: definitely-missing-envman not found on PATH')
    expect(call.events.filter((e) => 'state' in e && e.state === 'skipped').map((e) => (e as { stage: string }).stage)).toEqual(['cli', 'auth', 'request'])
    expect(logLines()).toEqual([])
  })

  it('a deleted profile fails before anything spawns', async () => {
    await put({ mode: 'command', profileId: 'gone' })
    const { final } = await test('ok')
    expect(final).toMatchObject({ result: 'failed', summary: 'The selected launch profile no longer exists. Pick another one.' })
    expect(logLines()).toEqual([])
  })

  it.each([
    ['verfail', 'cli', 'check_failed'],
    ['nonjson', 'request', 'request_failed'],
    ['e401', 'request', 'auth_rejected'],
    ['e404', 'request', 'model_not_found'],
    ['e429', 'request', 'rate_limited'],
    ['dns', 'request', 'network'],
  ])('%s -> fails at %s as %s, with no stdout/stderr in the stream', async (mode, stage, failed) => {
    await put({ mode: 'command', profileId: 'p' })
    const { call, final } = await test(mode)
    expect(final).toMatchObject({ result: 'failed', stage, failed })
    expect(call.body).not.toContain(LEAK)
    expect(call.body).not.toContain('boom')
  })

  it('a hung request is killed at the timeout', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const t0 = Date.now()
    const { final } = await test('hang', { requestTimeoutMs: 300 })
    expect(final).toMatchObject({ result: 'failed', stage: 'request', failed: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(4000)
  })

  it('one test at a time: a second request while one runs joins it (one -p spawn, same events for both)', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const a = postTest(testDeps('slow'))
    await new Promise((r) => setTimeout(r, 100))
    const b = postTest(testDeps('slow'))
    await Promise.all([a.done, b.done])
    expect(b.events).toEqual(a.events)
    expect(logLines().filter((l) => l.includes(' -p '))).toHaveLength(1)
  })

  it('Cancel (every watcher leaves) kills the running request and keeps no result', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const t0 = Date.now()
    const a = postTest(testDeps('hang'))
    await vi.waitFor(() => expect(logLines().some((l) => l.includes(' -p '))).toBe(true), { timeout: 3000 })
    a.leave()
    // The next test starts fresh (the cancelled flight is gone) and finishes long before the hang would.
    const { final } = await test('ok')
    expect(final.result).toBe('ok')
    expect(Date.now() - t0).toBeLessThan(4000)
  })

  it('agents and non-browser callers get 403; GET is 405', async () => {
    expect(postTest(testDeps('ok'), { method: 'POST', headers: {} } as unknown as IncomingMessage).status).toBe(403)
    expect(postTest(testDeps('ok'), { ...ui('GET') } as IncomingMessage).status).toBe(405)
  })

  it('does not use a shell: metacharacters in the command are plain arguments', async () => {
    setProfiles([{ id: 'm', name: 'M', command: `${join(dir, 'claude')} '--x;touch ${join(dir, 'pwned')}'` }])
    await put({ mode: 'command', profileId: 'm' })
    await test('ok')
    expect(() => readFileSync(join(dir, 'pwned'))).toThrow()
    expect(readFileSync(log, 'utf8')).toContain(`--x;touch ${join(dir, 'pwned')} -p`)
  })
})

describe('GET /detect', () => {
  it('lists the known wrappers with installed state and a version-looking token only', async () => {
    const run = async (cmd: string) => ({ code: 0, stdout: cmd === 'op' ? `1.2.3-beta ${LEAK}\n` : 'no version here\n', timedOut: false })
    const r = await handleProviderApi(ui('GET'), url(`${PROVIDER_PATH}/detect`), '', deps('ok', { run, onPath: (n) => n === 'op' || n === 'envman' }))
    expect(r.body).toEqual({ wrappers: [
      { name: 'aws-vault', installed: false },
      { name: 'direnv', installed: false },
      { name: 'doppler', installed: false },
      { name: 'envman', installed: true },
      { name: 'infisical', installed: false },
      { name: 'op', installed: true, version: '1.2.3-beta' },
    ] })
    expect(JSON.stringify(r.body)).not.toContain(LEAK)
  })

  it('a failing --version still reports installed; agents get 403', async () => {
    const run = async () => { throw new Error('spawn op failed: EACCES') }
    const r = await handleProviderApi(ui('GET'), url(`${PROVIDER_PATH}/detect`), '', deps('ok', { run, onPath: (n) => n === 'doppler' }))
    expect((r.body as { wrappers: { name: string; installed: boolean }[] }).wrappers.find((w) => w.name === 'doppler')).toEqual({ name: 'doppler', installed: true })
    const denied = await handleProviderApi({ method: 'GET', headers: {} } as unknown as IncomingMessage, url(`${PROVIDER_PATH}/detect`), '', deps())
    expect(denied.status).toBe(403)
  })
})
