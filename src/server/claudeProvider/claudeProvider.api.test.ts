import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleProviderApi, lastProviderTest, PROVIDER_PATH, type ProviderApiDeps } from './claudeProvider.api'
import { providerDir } from './claudeProvider.store'

const KEY = 'sk-test-only-0123456789abcdef' // test-only
const NODE_TOKEN = 'node-token-test-only' // test-only
let dir = ''
let prev: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-api-'))
  prev = process.env.WEBTERM_DATA_DIR
  process.env.WEBTERM_DATA_DIR = join(dir, 'data')
})
afterEach(() => {
  process.env.WEBTERM_DATA_DIR = prev
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const ui = (method: string, extra: Record<string, string> = {}): IncomingMessage =>
  ({ method, headers: { host: 'localhost:8700', origin: 'http://localhost:8700', 'sec-fetch-site': 'same-origin', ...extra } }) as unknown as IncomingMessage

function deps(extra: Partial<ProviderApiDeps> = {}): ProviderApiDeps {
  return {
    isNodeToken: (t) => t === NODE_TOKEN,
    sessionsBefore: () => 2,
    loginReady: async () => ({ ok: true }),
    fetch: (async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })) as unknown as typeof fetch,
    now: () => 1000,
    ...extra,
  }
}
const url = (p = PROVIDER_PATH) => new URL(`http://localhost:8700${p}`)
const put = (body: unknown, d = deps()) => handleProviderApi(ui('PUT'), url(), JSON.stringify(body), d)

describe('claude provider API', () => {
  it('agents and non-browser callers get 403', async () => {
    expect((await handleProviderApi(ui('GET', { 'x-webterm-token': NODE_TOKEN }), url(), '', deps())).status).toBe(403)
    expect((await handleProviderApi({ method: 'GET', headers: {} } as unknown as IncomingMessage, url(), '', deps())).status).toBe(403)
  })

  it('PUT saves; no response or log ever carries the key', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    const r = await put({ mode: 'custom', baseUrl: 'https://gw.example.test/v1', credential: 'authToken', secret: KEY })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ provider: { mode: 'custom', baseUrl: 'https://gw.example.test', secretSet: true, ready: true, updatedAt: 1000 }, restartNeeded: 2 })
    expect(JSON.stringify(r.body)).not.toContain(KEY)
    const get = await handleProviderApi(ui('GET'), url(), '', deps())
    expect(JSON.stringify(get.body)).not.toContain(KEY)
    expect(readFileSync(join(providerDir(), 'CONFIG'), 'utf8')).not.toContain(KEY)
    for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(KEY)
  })

  it('bad input is a static 400 that never echoes the body', async () => {
    const r = await handleProviderApi(ui('PUT'), url(), `{"secret":"${KEY}"`, deps())
    expect(r).toEqual({ status: 400, body: { error: 'invalid_json' } })
    const r2 = await put({ mode: 'custom', baseUrl: 'ftp://x', secret: KEY })
    expect(r2).toEqual({ status: 400, body: { error: 'invalid_base_url' } })
    expect(existsSync(join(providerDir(), 'CONFIG'))).toBe(false)
  })

  it('POST /test probes the saved provider and keeps the result for the Doctor', async () => {
    await put({ mode: 'apiKey', secret: KEY })
    const r = await handleProviderApi(ui('POST'), url(`${PROVIDER_PATH}/test`), '', deps())
    expect(r.body).toMatchObject({ test: { outcome: 'ok', ok: true, at: 1000 } })
    expect(lastProviderTest()).toMatchObject({ ok: true })
    await put({ mode: 'apiKey' }) // a change clears the stale result
    expect(lastProviderTest()).toBeNull()
  })

  it('login mode tests Claude Code login readiness', async () => {
    const r = await handleProviderApi(ui('POST'), url(`${PROVIDER_PATH}/test`), '', deps({ loginReady: async () => ({ ok: false, hint: 'Not signed in.' }) }))
    expect(r.body).toMatchObject({ test: { ok: false, message: 'Not signed in.' } })
  })
})
