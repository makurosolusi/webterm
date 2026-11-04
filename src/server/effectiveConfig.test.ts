// Control panel read model (F0-c): sources, reasons, secrets, mock badge, route gate, and the A2 drift test.
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import { buildEffectiveConfig, type EffectiveRow } from './effectiveConfig'
import { ENV_ONLY_PENDING_F1, uiWhere } from './effectiveConfig.ui'
import { controlEffectiveRoute, rootReader } from './envSettings.api'
import { capabilitiesRoute } from './featureCapabilities.api'
import { fakeReq, recorder, SENTINEL_BOT_TOKEN, setupEnv } from './envSettings.testutil'

function build(env: NodeJS.ProcessEnv, stored: string | null = null, dotenv: string[] = []) {
  const s = setupEnv(env, stored)
  const out = buildEffectiveConfig({ state: s.svc.state({ root: true }), env: s.target, dotenvKeys: new Set(dotenv), bootstrapKeys: BOOTSTRAP_ONLY_KEYS })
  const row = (k: string): EffectiveRow => out.rows.find((r) => r.key === k) as EffectiveRow
  return { out, row }
}

describe('buildEffectiveConfig', () => {
  it('lists every registry key plus the WEBTERM_* bootstrap keys', () => {
    const { out } = build({})
    const keys = out.rows.map((r) => r.key)
    for (const s of ENV_REGISTRY) expect(keys).toContain(s.key)
    expect(keys).toContain('WEBTERM_TOKEN')
    expect(keys).not.toContain('HOST')
  })

  it('tells default, shell env, .env, Settings and capability sources apart', () => {
    const stored = JSON.stringify({ WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_CHAT: 'on', WEBTERM_LOG_BUFFER: '900' })
    const { row } = build({ WEBTERM_LEDGER: 'shadow', WEBTERM_LOG_LEVEL: 'debug' }, stored, ['WEBTERM_LOG_LEVEL'])
    expect(row('WEBTERM_FILES_LIST_MAX')).toMatchObject({ source: 'default', modified: false, reason: 'Code default.', envOnly: true })
    expect(row('WEBTERM_LEDGER')).toMatchObject({ source: 'env', value: 'shadow', modified: true })
    expect(row('WEBTERM_LOG_LEVEL')).toMatchObject({ source: '.env', value: 'debug', reason: 'From the .env file in the server folder.' })
    expect(row('WEBTERM_CENTRAL')).toMatchObject({ source: 'settings', value: 'on', ui: 'Settings › Capabilities › Central agent', envOnly: false })
    expect(row('WEBTERM_CENTRAL').reason).toBe('Set in Settings › Capabilities › Central agent.')
    expect(row('WEBTERM_CENTRAL_CHAT')).toMatchObject({ source: 'capability', reason: 'Derived from the Central agent card (Central agent on).' })
    expect(row('WEBTERM_LOG_BUFFER').reason).toContain('no UI switch yet')
  })

  it('derived row names the card it follows (Worker card)', () => {
    const { row } = build({}, JSON.stringify({ WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_TOOLS: 'write' }))
    expect(row('WEBTERM_CENTRAL_TOOLS')).toMatchObject({ source: 'capability', value: 'write' })
    expect(row('WEBTERM_CENTRAL_TOOLS').reason).toContain('Worker orchestrator card (Worker orchestrator on)')
  })

  it('secrets and bootstrap keys carry set/unset only, never a value', () => {
    const { out, row } = build({ WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_TOKEN: 'root-token-test-only' })
    expect(JSON.stringify(out)).not.toContain(SENTINEL_BOT_TOKEN)
    expect(JSON.stringify(out)).not.toContain('root-token-test-only')
    expect(row('WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ secret: true, set: true, value: '' })
    expect(row('WEBTERM_TOKEN')).toMatchObject({ bootstrap: true, set: true, value: '', envOnly: true })
    expect(row('WEBTERM_DATA_DIR')).toMatchObject({ set: false, source: 'default' })
  })

  it('raises the MOCK badge only when a runtime resolves to the mock engine', () => {
    expect(build({}).out.mock).toEqual({ active: false, keys: [] })
    const { out, row } = build({ WEBTERM_CENTRAL_RUNTIME: 'mock' })
    expect(out.mock).toEqual({ active: true, keys: ['WEBTERM_CENTRAL_RUNTIME'] })
    expect(row('WEBTERM_CENTRAL_RUNTIME')).toMatchObject({ mock: true, value: 'mock' })
    expect(row('WEBTERM_CENTRAL_RUNTIME').reason).toMatch(/^MOCK:/)
  })

  it('unset runtime shows what auto-detect resolves to, never mock', () => {
    const { row } = build({ PATH: '' })
    expect(row('WEBTERM_CENTRAL_RUNTIME').value).toBe('auto (off)')
    expect(row('WEBTERM_CENTRAL_RUNTIME').mock).toBeUndefined()
  })
})

describe('A2 drift: every behaviour key has a UI switch or is listed env-only pending F1', () => {
  it('registry and allowlist agree', () => {
    const registry = new Set(ENV_REGISTRY.map((s) => s.key))
    const envOnly = ENV_REGISTRY.filter((s) => uiWhere(s.key) === null).map((s) => s.key)
    console.info(`[A2] env-only, pending F1 (${envOnly.length}): ${envOnly.join(', ')}`)
    expect(envOnly.filter((k) => !ENV_ONLY_PENDING_F1.includes(k))).toEqual([]) // new hidden knob
    expect(ENV_ONLY_PENDING_F1.filter((k) => !registry.has(k) || uiWhere(k) !== null)).toEqual([]) // stale entry
  })
})

describe('GET /api/control/effective', () => {
  const svc = () => setupEnv({}).svc
  const req = (headers: Record<string, string>) => Object.assign(fakeReq('GET'), { headers })

  it('serves the model to the owner', () => {
    const res = recorder()
    controlEffectiveRoute(req({}), res, 'GET', { service: svc(), env: {}, dotenvKeys: new Set(), rootToken: null })
    expect(res.status).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect((res.json() as { rows: unknown[] }).rows.length).toBeGreaterThan(ENV_REGISTRY.length)
  })

  it('refuses node and capability tokens, and wrong root tokens', () => {
    expect(rootReader(req({ 'x-webterm-token': 'node-token' }), undefined)).toBe(false)
    expect(rootReader(req({ 'x-webterm-capability': 'wcap_x' }), undefined)).toBe(false)
    expect(rootReader(req({ 'x-webterm-token': 'wrong' }), 'root')).toBe(false)
    expect(rootReader(req({}), 'root')).toBe(false)
    expect(rootReader(req({ 'x-webterm-token': 'root' }), 'root')).toBe(true)
    const res = recorder()
    controlEffectiveRoute(req({ 'x-webterm-token': 'node-token' }), res, 'GET', { service: svc(), rootToken: null })
    expect(res.status).toBe(403)
  })

  it('rejects writes with 405', () => {
    const res = recorder()
    controlEffectiveRoute(req({}), res, 'PUT', { service: svc(), rootToken: null })
    expect(res.status).toBe(405)
  })

  it('is reachable through the capabilities dispatcher (mounted before /api/control/*)', async () => {
    const res = recorder()
    const deps = () => ({ service: svc(), guard: () => ({ ok: true as const, via: 'ui' as const }) })
    const handled = await capabilitiesRoute(req({ 'x-webterm-capability': 'wcap_x' }), res, 'GET', '/api/control/effective', deps, { env: {} })
    expect(handled).toBe(true)
    expect(res.status).toBe(403)
  })
})
