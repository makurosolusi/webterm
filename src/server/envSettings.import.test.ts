// Impor `.env` -> override: klasifikasi, gerbang dangerous/root, apply atomik, nol nilai di respons.
// `.env` SINTETIS di mkdtemp; cwd disuntik lewat recordDotenvBoot (sekali per proses = per berkas tes).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDotenvBoot } from './dotenvFiles'
import { createFileSecretStore } from './envSecrets.store'
import { createEnvSettings } from './envSettings.service'
import { importDotenv } from './envSettings.import'
import { BOOTSTRAP_ONLY_KEYS, ENV_REGISTRY } from './envRegistry'
import { memOverrides, setupEnv, SENTINEL_BOT_TOKEN } from './envSettings.testutil'

// test-only: nilai palsu penanda yang dicari di SELURUH respons.
const ROOT_MARK = 'sentinel-root-token-value'
const BIN_MARK = '/usr/bin/sentinel-bin'
const cwd = mkdtempSync(join(tmpdir(), 'envimport-'))
recordDotenvBoot(cwd, {})
const dotenv = (lines: string[]): void => writeFileSync(join(cwd, '.env'), lines.join('\n') + '\n')
const keyOf = (r: ReturnType<typeof importDotenv>, key: string) => (r.status === 200 ? r.body.items.find((i) => i.key === key) : undefined)

describe('importDotenv klasifikasi', () => {
  it('add / same / conflict / bootstrap / invalid / ignored; dry-run tak mengubah override', () => {
    const { svc, overrides } = setupEnv()
    svc.update({ set: { WEBTERM_LEDGER: 'shadow', WEBTERM_CENTRAL_SKILLS: 'off' }, unset: [] }, { root: true })
    const before = overrides.json
    dotenv([
      'WEBTERM_CENTRAL=on', 'WEBTERM_LEDGER=shadow', 'WEBTERM_CENTRAL_SKILLS=on', 'HOST=0.0.0.0', 'PORT=9', `WEBTERM_TOKEN=${ROOT_MARK}`,
      'WEBTERM_CENTRAL_MAX_STEPS=999', 'NOT_IN_REGISTRY=x', 'ALSO_UNKNOWN=y',
    ])
    const r = importDotenv({ service: svc }, false)
    expect(r.status).toBe(200)
    if (r.status !== 200) return
    expect(r.body).toMatchObject({ found: true, ignored: 2 })
    expect(keyOf(r, 'WEBTERM_CENTRAL')).toMatchObject({ action: 'add', dangerous: false, secret: false })
    expect(keyOf(r, 'WEBTERM_LEDGER')?.action).toBe('same')
    expect(keyOf(r, 'WEBTERM_CENTRAL_SKILLS')?.action).toBe('conflict')
    for (const k of ['HOST', 'PORT', 'WEBTERM_TOKEN']) expect(keyOf(r, k)).toMatchObject({ action: 'skip', reason: 'bootstrap' })
    expect(keyOf(r, 'WEBTERM_CENTRAL_MAX_STEPS')).toMatchObject({ action: 'skip', reason: 'invalid' })
    expect(r.body.applied).toBeUndefined()
    expect(overrides.json).toBe(before)
    expect(JSON.stringify(r.body)).not.toContain(ROOT_MARK)
  })

  it('apply: add tertulis, conflict TIDAK ditimpa, bootstrap tak pernah tertulis', () => {
    const { svc, overrides, target } = setupEnv()
    svc.update({ set: { WEBTERM_CENTRAL_SKILLS: 'off' }, unset: [] }, { root: true })
    dotenv(['WEBTERM_CENTRAL=on', 'WEBTERM_CENTRAL_SKILLS=on', 'PORT=9', 'HOST=0.0.0.0'])
    const r = importDotenv({ service: svc }, true)
    expect(r.status === 200 && r.body.applied).toBe(1)
    const stored = JSON.parse(overrides.json ?? '{}')
    expect(stored).toEqual({ WEBTERM_CENTRAL_SKILLS: 'off', WEBTERM_CENTRAL: 'on' })
    expect(target.PORT).toBeUndefined()
    expect(overrides.json).not.toContain('HOST')
  })

  it('tanpa item add: apply = 0 tanpa menulis', () => {
    const { svc, overrides } = setupEnv()
    dotenv(['PORT=9'])
    const r = importDotenv({ service: svc }, true)
    expect(r.status === 200 && r.body.applied).toBe(0)
    expect(overrides.saves).toBe(0)
  })

  it('.env hilang => found:false', () => {
    const { svc } = setupEnv()
    rmSync(join(cwd, '.env'), { force: true })
    expect(importDotenv({ service: svc }, true)).toEqual({ status: 200, body: { found: false, ignored: 0, items: [] } })
  })

  it('terkunci => 403 locked seperti PUT, tanpa efek', () => {
    const { svc, overrides } = setupEnv({ WEBTERM_ENV_SETTINGS: 'off' })
    dotenv(['WEBTERM_CENTRAL=on'])
    expect(importDotenv({ service: svc }, true)).toEqual({ status: 403, body: { error: 'locked' } })
    expect(overrides.saves).toBe(0)
  })
})

describe('importDotenv gerbang dangerous', () => {
  it('kunci dangerous ikut tertulis', () => {
    const { svc, overrides } = setupEnv()
    dotenv([`WEBTERM_OPENCODE_BIN=${BIN_MARK}`])
    const ok = importDotenv({ service: svc }, true)
    expect(keyOf(ok, 'WEBTERM_OPENCODE_BIN')?.action).toBe('add')
    expect(JSON.parse(overrides.json ?? '{}')).toEqual({ WEBTERM_OPENCODE_BIN: BIN_MARK })
    expect(JSON.stringify(ok)).not.toContain(BIN_MARK)
  })
})

describe('importDotenv secret + atomik', () => {
  it('secret masuk store 0600 (bukan blob override) dan nilainya tak ada di respons', () => {
    const secretsDir = join(mkdtempSync(join(tmpdir(), 'envimport-sec-')), 'secrets')
    const overrides = memOverrides()
    const svc = createEnvSettings({ registry: ENV_REGISTRY, bootstrapKeys: BOOTSTRAP_ONLY_KEYS, target: {}, overrides, secrets: createFileSecretStore(secretsDir) })
    svc.apply()
    dotenv([`WEBTERM_TELEGRAM_BOT_TOKEN=${SENTINEL_BOT_TOKEN}`])
    const r = importDotenv({ service: svc }, true)
    expect(keyOf(r, 'WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ action: 'add', secret: true })
    expect(statSync(join(secretsDir, 'WEBTERM_TELEGRAM_BOT_TOKEN')).mode & 0o777).toBe(0o600)
    expect(overrides.json ?? '').not.toContain('SENTINEL')
    expect(JSON.stringify(r)).not.toContain('SENTINEL')
  })

  it('galat tulis secret => 500 store_failed, rollback, applied tak ada, nilai tak bocor', () => {
    const { svc, overrides, secrets } = setupEnv()
    secrets.failOn = 'WEBTERM_TELEGRAM_BOT_TOKEN'
    dotenv(['WEBTERM_CENTRAL=on', `WEBTERM_TELEGRAM_BOT_TOKEN=${SENTINEL_BOT_TOKEN}`])
    const r = importDotenv({ service: svc }, true)
    expect(r.status).toBe(500)
    expect('applied' in r.body).toBe(false)
    expect(overrides.json).toBeNull()
    expect(secrets.files.size).toBe(0)
    expect(JSON.stringify(r)).not.toContain('SENTINEL')
  })
})
