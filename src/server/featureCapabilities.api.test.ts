import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { TEST_TOKEN, fakeBotApi, ok } from './channels/telegramPollHarness'
import { setupEnv, recorder } from './envSettings.testutil'
import { capabilitiesRoute } from './featureCapabilities.api'
import type { AuditEntry } from './featureCapabilities.audit'
import { settingsGuard } from './featureCapabilities.guard'
import { onCapabilityChange } from './featureCapabilities.runtime'

// test-only: server nyata untuk semua hal kecuali jaringan; guard asli dengan env kosong (port bawaan, tanpa token).
const ORIGIN = 'http://127.0.0.1:8700'
interface Opts { origin?: string | null; remote?: boolean; query?: string }

function harness(fetch = fakeBotApi([]).fetch) {
  const h = setupEnv({})
  const audits: AuditEntry[] = []
  const deps = { service: h.svc, guard: (req: IncomingMessage) => settingsGuard(req, {}, undefined), audit: (e: AuditEntry) => { audits.push(e) } }
  const detectCalls: Array<{ fresh?: boolean } | undefined> = []
  const extras = { env: h.target, detect: (o?: { fresh?: boolean }) => { detectCalls.push(o); return { chromium: true, telegramToken: false, agentEngine: true } }, dataDir: '/tmp/webterm-test-data', secrets: h.secrets, fetch }
  const call = async (method: string, path: string, body?: unknown, opts: Opts = {}) => {
    const headers: Record<string, string> = { host: '127.0.0.1:8700' }
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const socket = { remoteAddress: opts.remote ? '203.0.113.9' : '127.0.0.1' }
    const req = Object.assign(Readable.from(raw), { method, headers, socket, url: path + (opts.query ?? '') }) as unknown as IncomingMessage
    const res = recorder()
    const handled = await capabilitiesRoute(req, res, method, path, () => deps, extras)
    return { handled, status: res.status, text: res.body, json: res.body ? (res.json() as Record<string, any>) : undefined } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return { ...h, audits, call, detectCalls }
}

const offs: Array<() => void> = []
const events: string[] = []
afterEach(() => { offs.splice(0).forEach((off) => off()); events.length = 0 })

describe('GET', () => {
  it('200 memuat tujuh kemampuan urut katalog dan bagian lanjutan, tanpa istilah konfigurasi', async () => {
    const h = harness()
    for (const path of ['/api/capabilities', '/api/capabilities/advanced']) {
      const r = await h.call('GET', path, undefined, { origin: null }) // GET tidak digerbangi penjaga
      expect(r.status).toBe(200)
      expect(r.json?.capabilities.map((c: { id: string }) => c.id)).toEqual(['central', 'workers', 'autonomy', 'browser', 'files', 'filesWrite', 'telegram'])
      expect(r.json?.advanced).toMatchObject({ agentEngine: { value: 'auto' }, chromiumPath: { value: '' } })
      for (const banned of ['restart', 'dangerous', 'WEBTERM_']) expect(r.text).not.toContain(banned)
    }
  })
  it('path lain dikembalikan false; rute/metode tak dikenal 404/405', async () => {
    const h = harness()
    expect((await h.call('GET', '/api/settings')).handled).toBe(false)
    expect((await h.call('GET', '/api/capabilitiesX')).handled).toBe(false)
    expect((await h.call('GET', '/api/capabilities/a/b/c')).status).toBe(404)
    expect((await h.call('GET', '/api/capabilities/central')).status).toBe(405)
    expect((await h.call('DELETE', '/api/capabilities')).status).toBe(405)
  })
})

describe('POST /:id', () => {
  it('200 menyalakan dan mematikan; audit mencatat peer dan via', async () => {
    const h = harness()
    const on = await h.call('POST', '/api/capabilities/autonomy', { enabled: true })
    expect(on.status).toBe(200)
    expect(on.json?.capabilities.find((c: { id: string }) => c.id === 'autonomy')).toMatchObject({ status: 'on' })
    expect(h.target.WEBTERM_CENTRAL).toBe('on')
    expect((await h.call('POST', '/api/capabilities/central', { enabled: false })).json?.capabilities.find((c: { id: string }) => c.id === 'autonomy').status).toBe('off')
    expect(h.audits).toEqual([
      { peer: 'loopback', via: 'ui', capability: 'autonomy', action: 'grant', detail: 'central,workers,autonomy' },
      { peer: 'loopback', via: 'ui', capability: 'central', action: 'revoke', detail: 'central,workers,autonomy' },
    ])
  })
  it('respons menyebut alsoTurnsOn untuk kemampuan yang ikut menyala', async () => {
    const r = await harness().call('POST', '/api/capabilities/autonomy', { enabled: true })
    expect(r.json?.capabilities.find((c: { id: string }) => c.id === 'autonomy').alsoTurnsOn).toEqual(['central', 'workers'])
  })
  it('400 invalid_body (bukan boolean / JSON rusak), 404 unknown_capability', async () => {
    const h = harness()
    expect((await h.call('POST', '/api/capabilities/central', { enabled: 'yes' })).json).toEqual({ error: 'invalid_body' })
    expect((await h.call('POST', '/api/capabilities/central', '{bukan json')).json).toEqual({ error: 'bad_json' })
    expect((await h.call('POST', '/api/capabilities/bogus', { enabled: true })).json).toEqual({ error: 'unknown_capability' })
    expect((await h.call('POST', '/api/capabilities/advanced/sub', { key: 'x', on: true })).status).toBe(404)
  })
  it('403 tanpa Origin, Origin asing, atau peer remote; tidak ada yang berubah dan denied dicatat', async () => {
    const h = harness()
    const blocked = [
      await h.call('POST', '/api/capabilities/central', { enabled: true }, { origin: null }),
      await h.call('POST', '/api/capabilities/central', { enabled: true }, { origin: 'http://evil.example' }),
      await h.call('POST', '/api/capabilities/central', { enabled: true }, { remote: true }),
    ]
    expect(blocked.map((r) => [r.status, r.json])).toEqual(Array(3).fill([403, { error: 'forbidden', port: 8700 }]))
    expect(h.target.WEBTERM_CENTRAL).toBeUndefined()
    expect(h.audits.map((a) => [a.action, a.via, a.detail])).toEqual([['denied', 'rejected', 'origin'], ['denied', 'rejected', 'origin'], ['denied', 'rejected', 'peer']])
  })
  it('GET ?refresh=1 meminta deteksi segar; GET biasa tetap memakai cache', async () => {
    const h = harness()
    expect((await h.call('GET', '/api/capabilities')).status).toBe(200)
    expect((await h.call('GET', '/api/capabilities', undefined, { query: '?refresh=1' })).status).toBe(200)
    expect(h.detectCalls).toEqual([{ fresh: false }, { fresh: true }])
  })
  it('403 memuat port dengar server (PORT), bukan port tunnel yang dilihat halaman', async () => {
    const h = harness()
    h.target.PORT = '9123' // test-only
    const r = await h.call('POST', '/api/capabilities/central', { enabled: true }, { origin: null })
    expect([r.status, r.json]).toEqual([403, { error: 'forbidden', port: 9123 }])
  })
  it('dua POST bersamaan konsisten dan tiap hook start/stop tepat sekali', async () => {
    offs.push(onCapabilityChange('files', { start: () => { events.push('start') }, stop: () => { events.push('stop') } }))
    const h = harness()
    const [a, b] = await Promise.all([
      h.call('POST', '/api/capabilities/files', { enabled: true }),
      h.call('POST', '/api/capabilities/files', { enabled: false }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(h.target.WEBTERM_FILES_VIEWERS).toBe('off')
    expect(events).toEqual(['start', 'stop'])
  })
})

describe('POST /:id/sub', () => {
  it('200 / 400 unknown_sub / 409 parent_off / 400 invalid_body / 403 / 404', async () => {
    const h = harness()
    const sub = (body: unknown, id = 'workers', opts?: Opts) => h.call('POST', `/api/capabilities/${id}/sub`, body, opts)
    expect((await sub({ key: 'runRequireApproval', on: false })).json).toEqual({ error: 'parent_off' })
    await h.call('POST', '/api/capabilities/workers', { enabled: true })
    const done = await sub({ key: 'runRequireApproval', on: false })
    expect(done.status).toBe(200)
    expect(done.json?.capabilities.find((c: { id: string }) => c.id === 'workers').subs[0]).toMatchObject({ key: 'runRequireApproval', on: false })
    expect((await sub({ key: 'WEBTERM_RUN_REQUIRE_APPROVAL', on: true })).json).toEqual({ error: 'unknown_sub' })
    expect((await sub({ key: 1, on: true })).json).toEqual({ error: 'invalid_body' })
    expect((await sub({ key: 'runRequireApproval', on: true }, 'workers', { origin: null })).status).toBe(403)
    expect((await sub({ key: 'x', on: true }, 'bogus')).status).toBe(404)
    expect(h.audits.some((a) => a.action === 'sub' && a.detail === 'runRequireApproval')).toBe(true)
  })
})

describe('PUT /advanced', () => {
  it('200 menulis mesin agen dan lokasi Chrome; GET mencerminkannya', async () => {
    const h = harness()
    const r = await h.call('PUT', '/api/capabilities/advanced', { agentEngine: 'opencode', chromiumPath: '/opt/chrome' })
    expect(r.status).toBe(200)
    expect(r.json?.advanced).toMatchObject({ agentEngine: { value: 'opencode' }, chromiumPath: { value: '/opt/chrome', detected: false, active: null, source: null, overrideInvalid: true } })
    expect(h.audits.at(-1)).toMatchObject({ capability: 'advanced', action: 'advanced', detail: 'agentEngine,chromiumPath' })
  })
  it('400 invalid_value hanya dengan nama field; 400 invalid_body; 403', async () => {
    const h = harness()
    const bad = await h.call('PUT', '/api/capabilities/advanced', { agentEngine: 'gpt' })
    expect([bad.status, bad.json]).toEqual([400, { error: 'invalid_value', field: 'agentEngine' }])
    expect((await h.call('PUT', '/api/capabilities/advanced', [])).json).toEqual({ error: 'invalid_body' })
    expect((await h.call('PUT', '/api/capabilities/advanced', {}, { origin: null })).status).toBe(403)
  })
})

describe('POST /telegram/connect', () => {
  it('200 menyalakan telegram HANYA setelah token diterima; respons tak memuat token', async () => {
    const h = harness(fakeBotApi([ok({ username: 'webterm_bot' })]).fetch)
    const r = await h.call('POST', '/api/capabilities/telegram/connect', { token: TEST_TOKEN })
    expect([r.status, r.json]).toEqual([200, { ok: true, bot: '@webterm_bot' }])
    expect(h.target.WEBTERM_TELEGRAM).toBe('on')
    expect(JSON.stringify([r.text, h.audits, h.logs])).not.toContain(TEST_TOKEN)
  })
  it('400 bentuk salah, 422 ditolak, 502 tak terjangkau: telegram tetap off dan tak ada token tersimpan', async () => {
    const cases: Array<[unknown[], string, number, string]> = [
      [[], 'bukan-token', 400, 'invalid_token_shape'],
      [[{ status: 401, body: { ok: false } }], TEST_TOKEN, 422, 'token_rejected'],
      [[new Error('ECONNREFUSED')], TEST_TOKEN, 502, 'unreachable'],
    ]
    for (const [script, token, status, error] of cases) {
      const h = harness(fakeBotApi(script as never).fetch)
      const r = await h.call('POST', '/api/capabilities/telegram/connect', { token })
      expect([r.status, r.json]).toEqual([status, { error }])
      expect(h.target.WEBTERM_TELEGRAM).toBeUndefined()
      expect(h.secrets.files.size).toBe(0)
    }
  })
  it('400 invalid_body tanpa token string; 403 tanpa Origin', async () => {
    const h = harness()
    expect((await h.call('POST', '/api/capabilities/telegram/connect', { token: 1 })).json).toEqual({ error: 'invalid_body' })
    expect((await h.call('POST', '/api/capabilities/telegram/connect', { token: TEST_TOKEN }, { origin: null })).status).toBe(403)
  })
})

describe('POST /reset', () => {
  it('200 menghapus override katalog; 403 tanpa Origin', async () => {
    const h = harness()
    await h.call('POST', '/api/capabilities/files', { enabled: true })
    expect((await h.call('POST', '/api/capabilities/reset', {}, { origin: null })).status).toBe(403)
    const r = await h.call('POST', '/api/capabilities/reset', {})
    expect(r.status).toBe(200)
    expect(h.target.WEBTERM_FILES_VIEWERS).toBeUndefined()
    expect(r.json?.capabilities.every((c: { status: string }) => c.status === 'off')).toBe(true)
  })
})

describe('index.ts', () => {
  it('tidak membaca token/flag saat boot: poller via hook, browser via activeBrowser(), reconcile dari himpunan kosong', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    for (const gone of ['startTelegramInbound', 'resolveTelegramMode', 'browserRuntime', 'startBrowserRuntime', 'startChannelsRuntime']) expect(src).not.toContain(gone)
    expect(src).toContain('await reconcile(new Set(), enabledSet(process.env))')
    expect(src.indexOf('registerBrowserCapability(')).toBeLessThan(src.indexOf('await reconcile('))
    expect(src.indexOf('registerTelegramHot(')).toBeLessThan(src.indexOf('await reconcile('))
  })
})
