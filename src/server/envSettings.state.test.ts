// State v2: normalisasi, validitas + rawValue, secret tanpa nilai, bootstrap keluar dari entries, effective.
import { describe, expect, it } from 'vitest'
import type { EnvEntryV2 } from '../shared/envSettings.contract'
import { buildEnvState, RAW_VALUE_MAX_CHARS } from './envSettings.state'
import { createEnvSettings } from './envSettings.service'
import { enumOf, flag, text } from './envRegistry.types'
import { BOOTSTRAP_ONLY_KEYS } from './envRegistry'
import { memOverrides, memSecrets, SENTINEL_BOT_TOKEN, setupEnv } from './envSettings.testutil'

const ROOT = { root: true }
const get = (s: ReturnType<typeof setupEnv>, key: string): EnvEntryV2 => s.svc.state(ROOT).entries.find((e) => e.key === key) as EnvEntryV2
const M = { label: 'l', description: 'd' }

describe('normalisasi + validitas', () => {
  it('flag env "ON" dinormalisasi ke on dan valid', () => {
    expect(get(setupEnv({ WEBTERM_CENTRAL: ' ON ' }), 'WEBTERM_CENTRAL')).toMatchObject({ value: 'on', valid: true, effective: 'on' })
  })

  it('flag bukan on/off -> valid:false, dibaca off, rawValue + alasan', () => {
    const e = get(setupEnv({ WEBTERM_CENTRAL: 'yes' }), 'WEBTERM_CENTRAL')
    expect(e).toMatchObject({ valid: false, value: 'off', effective: 'off', rawValue: 'yes' })
    expect(e.invalidReason).toBeTruthy()
  })

  it('enum cocok case-insensitive -> nilai kanonik', () => {
    expect(get(setupEnv({ WEBTERM_LEDGER: 'SHADOW' }), 'WEBTERM_LEDGER')).toMatchObject({ value: 'shadow', valid: true })
  })

  it('enum asing -> valid:false, nilai = default, rawValue dipotong 40', () => {
    const long = 'x'.repeat(100)
    const e = get(setupEnv({ WEBTERM_LEDGER: long }), 'WEBTERM_LEDGER')
    expect(e).toMatchObject({ valid: false, value: 'off', effective: 'off' })
    expect(e.rawValue).toBe('x'.repeat(RAW_VALUE_MAX_CHARS))
    expect(RAW_VALUE_MAX_CHARS).toBe(40)
    expect(e.invalidReason).toBeTruthy()
  })

  it('nilai valid tidak membawa rawValue/invalidReason; kosong = default valid', () => {
    const e = get(setupEnv(), 'WEBTERM_LEDGER')
    expect(e).toMatchObject({ value: 'off', valid: true, source: 'default' })
    expect(e.rawValue).toBeUndefined()
    expect(e.invalidReason).toBeUndefined()
  })
})

describe('secret + bootstrap', () => {
  it('secret tak pernah membawa nilai (override tersimpan, env, dan env berbentuk salah)', () => {
    const s = setupEnv({ WEBTERM_TELEGRAM_WEBHOOK_SECRET: 'bad shape with spaces', WEBTERM_TOKEN: 'root-tok-sentinel' })
    s.svc.update({ set: { WEBTERM_TELEGRAM_BOT_TOKEN: SENTINEL_BOT_TOKEN }, unset: [] }, ROOT)
    const st = s.svc.state(ROOT)
    for (const k of ['WEBTERM_TELEGRAM_BOT_TOKEN', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET']) {
      const e = st.entries.find((x) => x.key === k)!
      expect(e).toMatchObject({ value: '', effective: '', valid: true })
      expect(e.rawValue).toBeUndefined()
    }
    expect(get(s, 'WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ set: true, secretSet: true, source: 'override' })
    const json = JSON.stringify(st)
    for (const secret of [SENTINEL_BOT_TOKEN, 'bad shape with spaces', 'root-tok-sentinel']) expect(json).not.toContain(secret)
  })

  it('kunci bootstrap tidak ada di entries; server.tokenSet boolean (kosong = false)', () => {
    const keys = BOOTSTRAP_ONLY_KEYS
    expect(keys.length).toBeGreaterThan(0)
    const st = setupEnv({ WEBTERM_TOKEN: 'tok', PORT: '1' }).svc.state(ROOT)
    for (const k of keys) expect(st.entries.some((e) => e.key === k)).toBe(false)
    expect(st.server.tokenSet).toBe(true)
    expect(setupEnv({ WEBTERM_TOKEN: '  ' }).svc.state(ROOT).server.tokenSet).toBe(false)
    expect(setupEnv().svc.state(ROOT).server.tokenSet).toBe(false)
  })
})

describe('effective vs value', () => {
  it('kunci boot: effective = nilai saat boot, value = override; pendingRestart', () => {
    const s = setupEnv()
    s.svc.update({ set: { WEBTERM_LEDGER: 'on' }, unset: [] }, ROOT)
    expect(get(s, 'WEBTERM_LEDGER')).toMatchObject({ value: 'on', effective: 'off', pendingRestart: true, restart: 'boot' })
  })

  it('kunci hot: effective mengikuti env proses langsung', () => {
    const s = setupEnv()
    s.svc.update({ set: { WEBTERM_CENTRAL: 'on' }, unset: [] }, ROOT)
    expect(get(s, 'WEBTERM_CENTRAL')).toMatchObject({ value: 'on', effective: 'on', pendingRestart: false, restart: 'hot' })
  })
})

describe('grup + metadata', () => {
  it('groups terurut berdasarkan order; grup core punya label', () => {
    const g = setupEnv().svc.state(ROOT).groups
    expect(g.map((x) => x.order)).toEqual([...g.map((x) => x.order)].sort((a, b) => a - b))
    expect(g.find((x) => x.id === 'telegram')).toMatchObject({ label: 'Telegram', owner: 'channels' })
  })

  it('registry kustom: grup asing -> advanced, owner = id, order 900; allowEmpty/unit diteruskan', () => {
    const registry = [
      flag('X_FLAG', 'zzz', M),
      text('X_TXT', 'zzz', { ...M, unit: 'ms', unsetLabel: '<dataDir>/x', allowEmpty: true }),
      enumOf('X_ENUM', 'zzz', ['a'], 'a', { ...M, optionLabels: { a: 'A' } }),
    ]
    const svc = createEnvSettings({ registry, bootstrapKeys: [], target: {}, overrides: memOverrides(), secrets: memSecrets(), log: { info: () => {}, warn: () => {} } })
    svc.apply()
    const st = svc.state(ROOT)
    expect(st.groups).toEqual([{ id: 'zzz', label: 'zzz', order: 900, owner: 'zzz' }])
    expect(st.entries.every((e) => e.audience === 'advanced' && e.owner === 'zzz' && e.section === 'zzz')).toBe(true)
    expect(st.entries.find((e) => e.key === 'X_TXT')).toMatchObject({ unit: 'ms', unsetLabel: '<dataDir>/x', allowEmpty: true })
    expect(st.entries.find((e) => e.key === 'X_ENUM')?.optionLabels).toEqual({ a: 'A' })
  })

  it('buildEnvState murni: tanpa overlay, entri sama dengan registry', () => {
    const st = buildEnvState({ registry: [flag('X_FLAG', 'zzz', M)], target: {}, base: {}, overrides: {}, fileSecrets: new Set(), bootEnv: undefined, locked: true, root: true })
    expect(st).toMatchObject({ locked: true, entries: [{ key: 'X_FLAG', editable: false, value: 'off', effective: 'off' }] })
  })
})

describe('provenance: envShadowed + varian _FILE', () => {
  const set = (s: ReturnType<typeof setupEnv>, k: string, v: string) => s.svc.update({ set: { [k]: v }, unset: [] }, ROOT)

  it('override berbeda dari env awal -> envShadowed true', () => {
    const s = setupEnv({ WEBTERM_CENTRAL: 'off' })
    set(s, 'WEBTERM_CENTRAL', 'on')
    expect(get(s, 'WEBTERM_CENTRAL')).toMatchObject({ source: 'override', envShadowed: true })
  })

  it('override sama dengan env (setelah normalisasi) -> field tidak ada', () => {
    const s = setupEnv({ WEBTERM_CENTRAL: ' ON ' })
    set(s, 'WEBTERM_CENTRAL', 'on')
    expect('envShadowed' in get(s, 'WEBTERM_CENTRAL')).toBe(false)
  })

  it('tanpa override, atau env kosong -> field tidak ada', () => {
    expect('envShadowed' in get(setupEnv({ WEBTERM_CENTRAL: 'on' }), 'WEBTERM_CENTRAL')).toBe(false)
    const s = setupEnv({ WEBTERM_CENTRAL: '  ' })
    set(s, 'WEBTERM_CENTRAL', 'on')
    expect('envShadowed' in get(s, 'WEBTERM_CENTRAL')).toBe(false)
  })

  it('secret override + env beda -> true, nilai tak pernah ada di JSON', () => {
    const envSecret = '999999:ENVsecretSENTINELvalue'
    const s = setupEnv({ WEBTERM_TELEGRAM_BOT_TOKEN: envSecret })
    set(s, 'WEBTERM_TELEGRAM_BOT_TOKEN', SENTINEL_BOT_TOKEN)
    expect(get(s, 'WEBTERM_TELEGRAM_BOT_TOKEN')).toMatchObject({ source: 'override', envShadowed: true })
    const json = JSON.stringify(s.svc.state(ROOT))
    for (const v of [envSecret, SENTINEL_BOT_TOKEN]) expect(json).not.toContain(v)
  })

  it('varian _FILE di env -> source env, bukan default', () => {
    const key = 'WEBTERM_TELEGRAM_WEBHOOK_SECRET'
    expect(get(setupEnv({ [`${key}_FILE`]: '/tmp/x' }), key)).toMatchObject({ source: 'env', set: true })
    expect(get(setupEnv(), key).source).toBe('default')
  })
})
