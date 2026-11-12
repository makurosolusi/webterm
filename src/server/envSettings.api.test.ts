// Rute GET/PUT /api/settings/env: bentuk respons, kode error, cap, dan nol kebocoran secret.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETTINGS_BODY_MAX_BYTES } from './cappedRequestBody'
import { recordDotenvBoot } from './dotenvFiles'
import type { AuditEntry } from './featureCapabilities.audit'
import { envImportRoute, envSettingsRoute, type EnvSettingsApiDeps } from './envSettings.api'
import { fakeReq, recorder, SENTINEL_BOT_TOKEN, setupEnv } from './envSettings.testutil'

const ALLOW: EnvSettingsApiDeps['guard'] = () => ({ ok: true, via: 'ui' })

async function call(method: string, body: unknown, env: NodeJS.ProcessEnv = {}) {
  const s = setupEnv(env)
  const res = recorder()
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  await envSettingsRoute(fakeReq(method, raw), res, method, { service: s.svc, guard: ALLOW })
  return { res, s, json: res.body ? (res.json() as Record<string, any>) : {} }
}

describe('GET', () => {
  it('state penuh, no-store, bootstrap tak editable', async () => {
    const { res, json } = await call('GET', undefined, { WEBTERM_LEDGER: 'shadow' })
    expect(res.status).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(json.locked).toBe(false)
    const ledger = json.entries.find((e: any) => e.key === 'WEBTERM_LEDGER')
    expect(ledger).toMatchObject({ source: 'env', value: 'shadow', restartRequired: true, dangerous: false, editable: true, kind: 'enum' })
    expect(json.entries.some((e: any) => e.key === 'HOST')).toBe(false)
    expect(json).toMatchObject({ server: { tokenSet: false, settingsLocked: false } })
    expect(json.groups.map((g: any) => g.id)).toContain('telegram')
    expect(json.entries.some((e: any) => e.key === 'WEBTERM_CHANNEL_HMAC_SECRET')).toBe(false)
  })
})

describe('PUT', () => {
  it('accepts keys the Central Agent section owns (that section writes through this route, Control refuses them)', async () => {
    const { res, s } = await call('PUT', { set: { WEBTERM_CENTRAL_DAILY_COST_MICROS: '5000000', WEBTERM_CENTRAL_TURN_STEPS: '20' } })
    expect(res.status).toBe(200)
    expect(s.target.WEBTERM_CENTRAL_DAILY_COST_MICROS).toBe('5000000')
    expect(s.target.WEBTERM_CENTRAL_TURN_STEPS).toBe('20')
  })
  it('menerapkan, membalas state baru + restartRequired', async () => {
    const { res, json, s } = await call('PUT', { set: { WEBTERM_LEDGER: 'on', WEBTERM_CENTRAL: 'on' } })
    expect(res.status).toBe(200)
    expect(json.restartRequired).toEqual(['WEBTERM_LEDGER'])
    expect(json.entries.find((e: any) => e.key === 'WEBTERM_CENTRAL')).toMatchObject({ source: 'override', value: 'on' })
    expect(s.target.WEBTERM_LEDGER).toBe('on')
  })

  it.each([
    [{ set: { NOPE: 'x' } }, 400, 'unknown_key'],
    [{ set: { PORT: '1' } }, 400, 'bootstrap_only'],
    [{ unset: ['WEBTERM_TOKEN'] }, 400, 'bootstrap_only'],
    [{ set: { WEBTERM_LEDGER: 'bad' } }, 400, 'invalid_value'],
    [{ set: 'x' }, 400, 'invalid_body'],
    [{ unset: [1] }, 400, 'invalid_body'],
    [[], 400, 'invalid_body'],
    ['{nope', 400, 'bad_json'],
  ])('%j -> %i %s', async (body, status, error) => {
    const { res, json } = await call('PUT', body)
    expect(res.status).toBe(status)
    expect(json.error).toBe(error)
  })

  it('kunci dangerous dari penjaga yang meloloskan kini 200', async () => {
    const { res, s } = await call('PUT', { set: { WEBTERM_CONTROL_CWD_ROOTS: '/bin/sh' } })
    expect(res.status).toBe(200)
    expect(s.target.WEBTERM_CONTROL_CWD_ROOTS).toBe('/bin/sh')
  })

  it('penjaga menolak: 403 forbidden tanpa efek, tanpa kata token, audit denied generik', async () => {
    const s = setupEnv({})
    const rows: AuditEntry[] = []
    const res = recorder()
    const deps: EnvSettingsApiDeps = { service: s.svc, guard: () => ({ ok: false, reason: 'origin' }), audit: (e) => rows.push(e) }
    await envSettingsRoute(fakeReq('PUT', JSON.stringify({ set: { WEBTERM_TELEGRAM: 'on' } })), res, 'PUT', deps)
    expect([res.status, res.json()]).toEqual([403, { error: 'forbidden' }])
    expect(s.target.WEBTERM_TELEGRAM).toBeUndefined()
    expect(rows).toEqual([{ capability: 'advanced', action: 'denied', peer: 'remote', via: 'rejected', detail: 'origin' }])
    expect(res.body).not.toMatch(/token/i)
  })

  it('PUT sukses mencatat audit hanya nama kunci; galat audit tidak menjatuhkan mutasi', async () => {
    const s = setupEnv({})
    const rows: AuditEntry[] = []
    const res = recorder()
    await envSettingsRoute(fakeReq('PUT', JSON.stringify({ set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN, WEBTERM_CENTRAL: 'on' } })), res, 'PUT',
      { service: s.svc, guard: ALLOW, audit: (e) => rows.push(e) })
    expect(res.status).toBe(200)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'advanced', via: 'ui', detail: 'WEBTERM_TELEGRAM_BOT_TOKEN,WEBTERM_CENTRAL' })
    expect(JSON.stringify(rows)).not.toContain('SENTINEL')
    const res2 = recorder()
    await envSettingsRoute(fakeReq('PUT', JSON.stringify({ unset: ['WEBTERM_CENTRAL'] })), res2, 'PUT',
      { service: s.svc, guard: ALLOW, audit: () => { throw new Error('disk penuh') } })
    expect(res2.status).toBe(200)
  })

  it('GET tidak melewati penjaga', async () => {
    const s = setupEnv({})
    const res = recorder()
    await envSettingsRoute(fakeReq('GET'), res, 'GET', { service: s.svc, guard: () => { throw new Error('tidak boleh dipanggil') } })
    expect(res.status).toBe(200)
  })

  it('terkunci: 403 locked untuk semua PUT', async () => {
    const { res, json } = await call('PUT', { set: { WEBTERM_CENTRAL: 'on' } }, { WEBTERM_ENV_SETTINGS: 'off' })
    expect(res.status).toBe(403)
    expect(json.error).toBe('locked')
  })

  it('body di atas cap 413', async () => {
    const { res } = await call('PUT', ' '.repeat(SETTINGS_BODY_MAX_BYTES + 1))
    expect(res.status).toBe(413)
  })

  it('nilai secret tak pernah muncul di respons sukses maupun error', async () => {
    const ok = await call('PUT', { set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN } })
    expect(ok.res.status).toBe(200)
    expect(ok.res.body).not.toContain('SENTINEL')
    expect(ok.json.entries.find((e: any) => e.key === 'WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ set: true })
    const bad = await call('PUT', { set: { WEBTERM_TELEGRAM_BOT_TOKEN: 'SENTINEL bad shape' } })
    expect(bad.res.status).toBe(400)
    expect(bad.res.body).not.toContain('SENTINEL')
  })

  it('method lain 405', async () => {
    expect((await call('POST', {})).res.status).toBe(405)
  })
})

describe('POST /import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envimport-api-'))
  recordDotenvBoot(dir, {})
  const imp = async (method: string, body: unknown, env: NodeJS.ProcessEnv = {}) => {
    const s = setupEnv(env)
    const res = recorder()
    await envImportRoute(fakeReq(method, body === undefined ? undefined : JSON.stringify(body)), res, method, { service: s.svc, guard: ALLOW })
    return { res, s, json: res.body ? (res.json() as Record<string, any>) : {} }
  }

  it('body path diabaikan: sumber tetap <bootCwd>/.env; default dry-run', async () => {
    writeFileSync(join(dir, '.env'), 'WEBTERM_CENTRAL=on\n')
    const { res, json, s } = await imp('POST', { path: '/etc/passwd' })
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ found: true, items: [{ key: 'WEBTERM_CENTRAL', action: 'add' }] })
    expect(s.overrides.saves).toBe(0)
  })

  it('apply menulis; body salah bentuk 400; method lain 405; >64 KiB 413; terkunci 403', async () => {
    const ok = await imp('POST', { apply: true })
    expect(ok.json).toMatchObject({ applied: 1 })
    expect(ok.s.target.WEBTERM_CENTRAL).toBe('on')
    expect((await imp('POST', { apply: 'yes' })).res.status).toBe(400)
    expect((await imp('GET', undefined)).res.status).toBe(405)
    expect((await imp('POST', ' '.repeat(SETTINGS_BODY_MAX_BYTES + 1))).res.status).toBe(413)
    const locked = await imp('POST', { apply: true }, { WEBTERM_ENV_SETTINGS: 'off' })
    expect([locked.res.status, locked.json.error]).toEqual([403, 'locked'])
  })
})
