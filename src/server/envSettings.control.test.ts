// /api/control/effective: read gate, Control writes (hot apply, env lock, card-owned keys), Doctor GET/POST.
import { describe, expect, it } from 'vitest'
import { TEST_UI_COOKIE } from './uiSession.testutil'
import type { DoctorDeps } from './doctor'
import { ENV_REGISTRY } from './envRegistry'
import { controlEffectiveRoute, type ControlDeps } from './envSettings.control'
import type { AuditEntry } from './featureCapabilities.audit'
import { capabilitiesRoute } from './featureCapabilities.api'
import { fakeReq, recorder, SENTINEL_WEBHOOK_SECRET, setupEnv } from './envSettings.testutil'
import type { EffectiveRow } from './effectiveConfig'

const req = (method: string, headers: Record<string, string> = {}, body?: string, url = '/api/control/effective') =>
  Object.assign(fakeReq(method, body), { headers, url })

function harness(env: NodeJS.ProcessEnv = {}, doctor?: Partial<DoctorDeps>) {
  const s = setupEnv(env)
  const audits: AuditEntry[] = []
  const deps: ControlDeps = {
    service: s.svc, env: s.target, dotenvKeys: new Set(), rootToken: null,
    guard: () => ({ ok: true, via: 'ui' }), audit: (e) => audits.push(e),
    ...(doctor ? { doctor: () => fakeDoctor(doctor) } : {}),
  }
  const call = async (method: string, body?: unknown, url?: string, doctorPath = false) => {
    const res = recorder()
    await controlEffectiveRoute(req(method, {}, body === undefined ? undefined : JSON.stringify(body), url), res, method, deps, doctorPath)
    return res
  }
  return { ...s, audits, deps, call }
}

function fakeDoctor(over: Partial<DoctorDeps>): DoctorDeps {
  return {
    onPath: () => true, claudeReady: async () => ({ ok: true }),
    generated: () => [], readFile: () => null, installGenerated: () => {}, telegram: async () => ({ state: 'unset' }),
    sandbox: () => ({ on: true, supported: true }), setSandbox: () => {}, looseDirs: () => [], tightenDirs: () => {},
    verifyLedger: () => null, ...over,
  }
}

const rowOf = (body: unknown, key: string) => (body as { rows: EffectiveRow[] }).rows.find((r) => r.key === key) as EffectiveRow

describe('GET', () => {
  it('serves the model to the owner, no-store', async () => {
    const res = await harness().call('GET')
    expect(res.status).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect((res.json() as { rows: unknown[] }).rows.length).toBeGreaterThan(ENV_REGISTRY.length)
  })

  it('real guard: the signed-in page and the root token read; node, capability, wrong tokens and no cookie are refused', async () => {
    const { guard: _fake, ...real } = harness().deps
    const status = async (method: string, headers: Record<string, string>, body?: string) => {
      const res = recorder()
      await controlEffectiveRoute(req(method, headers, body), res, method, { ...real, rootToken: 'root' })
      return res.status
    }
    expect(await status('GET', { cookie: TEST_UI_COOKIE })).toBe(200)
    expect(await status('GET', { 'x-webterm-token': 'root' })).toBe(200)
    const refused: Array<Record<string, string>> = [{}, { 'x-webterm-token': 'node-token', cookie: TEST_UI_COOKIE }, { 'x-webterm-capability': 'wcap_x', cookie: TEST_UI_COOKIE }, { 'x-webterm-token': 'wrong' }]
    for (const headers of refused) {
      expect(await status('GET', headers)).toBe(403)
    }
    // A write also needs a same-origin Origin beside the cookie.
    expect(await status('PUT', { host: 'h:1', cookie: TEST_UI_COOKIE }, '{}')).toBe(403)
    expect(await status('PUT', { host: 'h:1', origin: 'http://h:1', cookie: TEST_UI_COOKIE }, '{}')).toBe(200)
  })

  it('rejects other methods with 405', async () => {
    expect((await harness().call('DELETE')).status).toBe(405)
  })

  it('is reachable through the capabilities dispatcher (mounted before /api/control/*)', async () => {
    const res = recorder()
    const deps = () => ({ service: setupEnv({}).svc, guard: () => ({ ok: true as const, via: 'ui' as const }) })
    const handled = await capabilitiesRoute(req('GET', { 'x-webterm-capability': 'wcap_x' }), res, 'GET', '/api/control/effective', deps, { env: {} })
    expect(handled).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(res.status).toBe(403)
  })
})

describe('PUT (Control writes)', () => {
  it('a hot knob is applied to the live env at once and the effective value changes', async () => {
    const h = harness()
    const res = await h.call('PUT', { set: { WEBTERM_AGENT_SANDBOX: 'off', WEBTERM_FILES_LIST_MAX: '777' }, unset: [] })
    expect(res.status).toBe(200)
    expect(h.target['WEBTERM_AGENT_SANDBOX']).toBe('off')
    expect(rowOf(res.json(), 'WEBTERM_AGENT_SANDBOX')).toMatchObject({ value: 'off', source: 'settings', modified: true })
    expect(rowOf(res.json(), 'WEBTERM_FILES_LIST_MAX').value).toBe('777')
    expect(h.audits).toEqual([{ capability: 'advanced', peer: 'remote', action: 'advanced', via: 'ui', detail: 'WEBTERM_AGENT_SANDBOX,WEBTERM_FILES_LIST_MAX' }])
    // Reset (VS Code "Reset Setting") clears the override.
    const reset = await h.call('PUT', { set: {}, unset: ['WEBTERM_FILES_LIST_MAX'] })
    expect(rowOf(reset.json(), 'WEBTERM_FILES_LIST_MAX')).toMatchObject({ source: 'default', modified: false })
  })

  it('a boot knob is stored but reports restartRequired and keeps the boot value effective', async () => {
    const res = await harness().call('PUT', { set: { WEBTERM_LOG_BUFFER: '900' }, unset: [] })
    const body = res.json() as { restartRequired: string[] }
    expect(body.restartRequired).toEqual(['WEBTERM_LOG_BUFFER'])
    expect(rowOf(body, 'WEBTERM_LOG_BUFFER')).toMatchObject({ setting: '900', pendingRestart: true, restart: 'boot' })
  })

  it('explicit shell env wins: the write is refused with the lock reason and nothing changes', async () => {
    const h = harness({ WEBTERM_LOG_LEVEL: 'debug' })
    const res = await h.call('PUT', { set: { WEBTERM_LOG_LEVEL: 'warn' }, unset: [] })
    expect(res.status).toBe(409)
    expect(res.json()).toMatchObject({ error: 'locked', key: 'WEBTERM_LOG_LEVEL' })
    expect(h.overrides.json).toBeNull()
    expect(h.target['WEBTERM_LOG_LEVEL']).toBe('debug')
  })

  it('card-owned keys and unknown keys are refused; invalid values come back 400 by name', async () => {
    const h = harness()
    expect((await h.call('PUT', { set: { WEBTERM_CENTRAL: 'on' } })).json()).toMatchObject({ error: 'managed_elsewhere', key: 'WEBTERM_CENTRAL' })
    expect((await h.call('PUT', { set: { WEBTERM_CENTRAL_DAILY_COST_MICROS: '1000000' } })).json())
      .toMatchObject({ error: 'managed_elsewhere', key: 'WEBTERM_CENTRAL_DAILY_COST_MICROS', reason: 'Managed in Settings › Central Agent › Daily spending limit.' })
    expect((await h.call('PUT', { set: { NOPE: '1' } })).json()).toMatchObject({ error: 'unknown_key' })
    const bad = await h.call('PUT', { set: { WEBTERM_FILES_LIST_MAX: 'lots' } })
    expect(bad.status).toBe(400)
    expect(bad.json()).toMatchObject({ error: 'invalid_value', key: 'WEBTERM_FILES_LIST_MAX' })
  })

  it('a secret is written through the secret store and only ever reported as set', async () => {
    const h = harness()
    const res = await h.call('PUT', { set: { WEBTERM_TELEGRAM_WEBHOOK_SECRET: SENTINEL_WEBHOOK_SECRET } })
    expect(res.status).toBe(200)
    expect(h.secrets.files.get('WEBTERM_TELEGRAM_WEBHOOK_SECRET')).toBe(SENTINEL_WEBHOOK_SECRET)
    expect(res.body).not.toContain(SENTINEL_WEBHOOK_SECRET)
    expect(rowOf(res.json(), 'WEBTERM_TELEGRAM_WEBHOOK_SECRET')).toMatchObject({ set: true, value: '', setting: '' })
  })

  it('a guard rejection is 403 and audited as denied', async () => {
    const h = harness()
    // Reads pass, so the refusal lands on the write check, where it is audited.
    h.deps.guard = (_req, purpose) => (purpose === 'read' ? { ok: true, via: 'ui' } : { ok: false, reason: 'origin' })
    const res = await h.call('PUT', { set: { WEBTERM_FILES_LIST_MAX: '5' } })
    expect(res.status).toBe(403)
    expect(h.audits[0]).toMatchObject({ action: 'denied', detail: 'origin' })
    expect(h.overrides.json).toBeNull()
  })
})

describe('Doctor over the route', () => {
  it('GET ?doctor=1 lists every check', async () => {
    const res = await harness({}, {}).call('GET', undefined, '/api/control/effective?doctor=1')
    const ids = (res.json() as { checks: { id: string }[] }).checks.map((c) => c.id)
    expect(ids).toEqual(['claude', 'skills', 'telegram', 'ripgrep', 'tmux', 'sandbox', 'dataDir', 'ledger'])
  })

  it('POST {fix} applies a safe fix and returns the re-run check; no fix on offer = 409', async () => {
    let tight = false
    const h = harness({}, { looseDirs: () => (tight ? [] : ['/data']), tightenDirs: () => { tight = true } })
    const res = await h.call('POST', { fix: 'dataDir' })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ id: 'dataDir', status: 'ok' })
    expect(h.audits.at(-1)).toMatchObject({ detail: 'doctor:dataDir' })
    expect((await h.call('POST', { fix: 'dataDir' })).status).toBe(409)
    expect((await h.call('POST', { fix: 'bogus' })).status).toBe(400)
  })

  it('/api/control/doctor is its own path: GET checks, POST fix, PUT refused', async () => {
    let tight = false
    const h = harness({}, { looseDirs: () => (tight ? [] : ['/data']), tightenDirs: () => { tight = true } })
    const list = await h.call('GET', undefined, '/api/control/doctor', true)
    expect((list.json() as { checks: { id: string }[] }).checks.map((c) => c.id)).toContain('dataDir')
    const fixed = await h.call('POST', { fix: 'dataDir' }, '/api/control/doctor', true)
    expect(fixed.json()).toMatchObject({ id: 'dataDir', status: 'ok' })
    expect((await h.call('PUT', { set: {}, unset: [] }, '/api/control/doctor', true)).status).toBe(405)
  })

  it('the capabilities route mounts /api/control/doctor (root-only like the effective path)', async () => {
    const h = harness()
    const res = recorder()
    const handled = await capabilitiesRoute(req('GET', { 'x-webterm-capability': 'wcap_x' }, undefined, '/api/control/doctor'), res, 'GET', '/api/control/doctor', () => ({ service: h.svc, guard: () => ({ ok: true, via: 'ui' }) }), { env: {} })
    expect(handled).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(res.status).toBe(403)
  })
})
