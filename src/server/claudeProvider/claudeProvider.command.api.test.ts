// Command mode end to end through the API with REAL child processes: fake `claude` scripts, no network,
// no real claude/envman. The fake prints secret-looking text so every case also proves it never leaks.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleProviderApi, PROVIDER_PATH, type ProviderApiDeps } from './claudeProvider.api'
import { registerClaudeLaunchSettings } from '../claudeLauncher/claudeLauncher'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const LEAK = 'sk-ant-LEAKLEAKLEAKLEAK1234' // test-only
const FAKE = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
V=0; case " $* " in *" --version "*) V=1 ;; esac
case "$FAKE_MODE" in
  signedout) echo "need auth to fetch x — not logged in: run 'claude login ${LEAK}'" >&2; exit 1 ;;
  verfail) echo "boom ${LEAK}" >&2; echo "${LEAK}"; exit 3 ;;
  nonjson) [ "$V" = 1 ] && { echo 2.1.0; exit 0; }; echo "not json ${LEAK}"; exit 0 ;;
  pingerror) [ "$V" = 1 ] && { echo 2.1.0; exit 0; }; echo '{"is_error":true,"result":"${LEAK}"}'; exit 0 ;;
  pingexit) [ "$V" = 1 ] && { echo 2.1.0; exit 0; }; echo "${LEAK}"; exit 1 ;;
  hang) [ "$V" = 1 ] && { echo 2.1.0; exit 0; }; sleep 5; exit 0 ;;
esac
[ "$V" = 1 ] && { echo 2.1.0; exit 0; }
echo '{"type":"result","is_error":false,"result":"${LEAK}"}'
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
  isNodeToken: () => false, sessionsBefore: () => 0, loginReady: async () => ({ ok: true }), now: () => 1000,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: mode, FAKE_LOG: log }, ...extra,
})
const url = (p = PROVIDER_PATH) => new URL(`http://localhost:8700${p}`)
const put = (body: unknown) => handleProviderApi(ui('PUT'), url(), JSON.stringify(body), deps())
const test = async (mode = 'ok', extra: Partial<ProviderApiDeps> = {}) => {
  const r = await handleProviderApi(ui('POST'), url(`${PROVIDER_PATH}/test`), '', deps(mode, extra))
  return { r, test: (r.body as { test: Record<string, unknown> }).test }
}

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

describe('POST /test in command mode', () => {
  it('ok: --version first (flags before it), then the minimal -p ping; nothing from the output is returned', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const { r, test: t } = await test('ok')
    expect(t).toEqual({ outcome: 'ok', ok: true, message: expect.stringContaining('Connected'), at: 1000 })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--model opus --version', '--model opus -p . --output-format json'])
    expect(JSON.stringify(r.body)).not.toContain(LEAK)
  })

  it('ENOENT / not on PATH -> command_not_found, naming the missing binary', async () => {
    setProfiles([{ id: 'e', name: 'E', command: 'definitely-missing-envman -e x -- claude' }])
    await put({ mode: 'command', profileId: 'e' })
    const { test: t } = await test('ok')
    expect(t).toMatchObject({ outcome: 'command_not_found', ok: false })
    expect(t.message).toMatch(/^definitely-missing-envman was not found on PATH/)
  })

  it('a deleted profile is not_configured and spawns nothing', async () => {
    await put({ mode: 'command', profileId: 'gone' })
    expect((await test('ok')).test).toMatchObject({ outcome: 'not_configured', ok: false })
  })

  it.each([
    ['verfail', 3],
    ['pingexit', 1],
    ['nonjson', undefined],
    ['pingerror', undefined],
  ])('%s -> command_failed with no stdout/stderr in the response', async (mode, exitCode) => {
    await put({ mode: 'command', profileId: 'p' })
    const { r, test: t } = await test(mode)
    expect(t).toMatchObject({ outcome: 'command_failed', ok: false })
    if (exitCode !== undefined) expect(t.exitCode).toBe(exitCode)
    expect(JSON.stringify(r.body)).not.toContain(LEAK)
    expect(JSON.stringify(r.body)).not.toContain('boom')
  })

  it('a wrapper that is not signed in says so, still without its output', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const { r, test: t } = await test('signedout')
    expect(t).toMatchObject({ outcome: 'command_failed', ok: false, exitCode: 1, message: 'claude is not signed in for the user webterm runs as. Sign in on the server, then Test connection again.' })
    expect(JSON.stringify(r.body)).not.toContain(LEAK)
  })

  it('a hung ping is killed at the timeout -> command_failed', async () => {
    await put({ mode: 'command', profileId: 'p' })
    const { probeCommand } = await import('./claudeProvider.commandProbe')
    const { resolveClaudeLaunch } = await import('../claudeLauncher/claudeLauncher')
    const t0 = Date.now()
    const t = await probeCommand(resolveClaudeLaunch('p'), { env: deps('hang').env as NodeJS.ProcessEnv, pingTimeoutMs: 300 })
    expect(t).toMatchObject({ outcome: 'command_failed', ok: false })
    expect(Date.now() - t0).toBeLessThan(4000)
  })

  it('does not use a shell: metacharacters in the command are plain arguments', async () => {
    setProfiles([{ id: 'm', name: 'M', command: `${join(dir, 'claude')} '--x;touch ${join(dir, 'pwned')}'` }])
    await put({ mode: 'command', profileId: 'm' })
    await test('ok')
    expect(() => readFileSync(join(dir, 'pwned'))).toThrow()
    expect(readFileSync(log, 'utf8')).toContain(`--x;touch ${join(dir, 'pwned')} --version`)
  })
})

describe('GET /detect', () => {
  it('lists the known wrappers with installed state and a version-looking token only', async () => {
    const run = async (cmd: string) => ({ code: 0, stdout: cmd === 'op' ? `1.2.3-beta ${LEAK}\n` : 'no version here\n', timedOut: false })
    const r = await handleProviderApi(ui('GET'), url(`${PROVIDER_PATH}/detect`), '', deps('ok', { run, onPath: (n) => n === 'op' || n === 'envman' }))
    expect(r.body).toEqual({ wrappers: [
      { name: 'envman', installed: true },
      { name: 'direnv', installed: false },
      { name: 'op', installed: true, version: '1.2.3-beta' },
      { name: 'doppler', installed: false },
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
