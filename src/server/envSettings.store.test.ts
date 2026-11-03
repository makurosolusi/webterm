// Store override non-secret di tabel `app` (node:sqlite sebagai pengganti bun:sqlite) + parser toleran.
import { describe, expect, it } from 'vitest'
import { ENV_REGISTRY } from './envRegistry'
import { enumOf, text, type EnvSpec } from './envRegistry.types'
import { createAppRowOverrideStore, ENV_OVERRIDES_ROW, parseOverrides, specResolver } from './envSettings.store'
import { nodeSqlite } from './nodeSqlite.testutil'

function appDb() {
  const { db, raw } = nodeSqlite()
  raw.exec('CREATE TABLE app (key TEXT PRIMARY KEY, value TEXT)')
  return { db, raw }
}

describe('createAppRowOverrideStore', () => {
  it('round-trip satu baris, upsert, dan tidak menyentuh baris settings', () => {
    const { db, raw } = appDb()
    raw.exec("INSERT INTO app (key, value) VALUES ('settings', '{\"a\":1}')")
    const store = createAppRowOverrideStore(db)
    expect(store.load()).toBeNull()
    store.save('{"WEBTERM_CENTRAL":"on"}')
    store.save('{"WEBTERM_CENTRAL":"off"}')
    expect(store.load()).toBe('{"WEBTERM_CENTRAL":"off"}')
    expect(raw.prepare('SELECT COUNT(*) AS n FROM app WHERE key = ?').get(ENV_OVERRIDES_ROW)).toEqual({ n: 1 })
    expect(raw.prepare("SELECT value FROM app WHERE key = 'settings'").get()).toEqual({ value: '{"a":1}' })
  })
})

describe('parseOverrides', () => {
  const warns: string[] = []
  const parse = (j: string | null, reg: readonly EnvSpec[] = ENV_REGISTRY) => parseOverrides(j, specResolver(reg), (m) => warns.push(m))
  it('null/kosong -> {}; valid lolos; sisanya dibuang', () => {
    expect(parse(null).values).toEqual({})
    expect(parse(JSON.stringify({ WEBTERM_CENTRAL: 'on', WEBTERM_LEDGER: 'zzz', WEBTERM_CENTRAL_MODEL: 7 })).values).toEqual({ WEBTERM_CENTRAL: 'on' })
    expect(warns.join()).toContain('WEBTERM_LEDGER')
  })

  it('kunci tak dikenal dipertahankan di unknownKept (tak diterapkan), warn hanya memuat nama', () => {
    warns.length = 0
    const r = parse(JSON.stringify({ WEBTERM_FUTURE_FLAG: 'SECRETISH-value', WEBTERM_CENTRAL: 'on' }))
    expect(r.values).toEqual({ WEBTERM_CENTRAL: 'on' })
    expect(r.unknownKept).toEqual({ WEBTERM_FUTURE_FLAG: 'SECRETISH-value' })
    expect(warns.join()).toContain('WEBTERM_FUTURE_FLAG')
    expect(warns.join()).not.toContain('SECRETISH')
  })

  // test-only: spec lokal dengan alias (belum ada rename nyata, P-14).
  const reg: EnvSpec[] = [enumOf('WEBTERM_NEW_MODE', 'central', ['a', 'b'], 'a', { label: 'x', description: 'x', aliases: ['WEBTERM_OLD_MODE'] }),
    text('WEBTERM_NEW_NAME', 'central', { label: 'y', description: 'y', aliases: ['WEBTERM_OLD_NAME'], allowEmpty: true })]
  it('alias dipetakan ke kunci kanonik (enum case-insensitive), kunci kanonik menang bila keduanya ada', () => {
    warns.length = 0
    expect(parse(JSON.stringify({ WEBTERM_OLD_MODE: 'B' }), reg)).toMatchObject({ values: { WEBTERM_NEW_MODE: 'b' }, unknownKept: {} })
    expect(warns.join()).toContain('mapped to WEBTERM_NEW_MODE')
    expect(parse(JSON.stringify({ WEBTERM_OLD_MODE: 'b', WEBTERM_NEW_MODE: 'a' }), reg).values).toEqual({ WEBTERM_NEW_MODE: 'a' })
  })

  it('nilai kosong (allowEmpty) tidak pernah menjadi override', () => {
    expect(parse(JSON.stringify({ WEBTERM_NEW_NAME: '' }), reg).values).toEqual({})
  })
})
