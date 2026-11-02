// Store override non-secret di tabel `app` (node:sqlite sebagai pengganti bun:sqlite) + parser toleran.
import { describe, expect, it } from 'vitest'
import { specFor } from './envRegistry'
import { createAppRowOverrideStore, ENV_OVERRIDES_ROW, parseOverrides } from './envSettings.store'
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
  const parse = (j: string | null) => parseOverrides(j, specFor, (m) => warns.push(m))
  it('null/kosong -> {}; valid lolos; sisanya dibuang', () => {
    expect(parse(null)).toEqual({})
    expect(parse(JSON.stringify({ WEBTERM_CENTRAL: 'on', WEBTERM_LEDGER: 'zzz', WEBTERM_CENTRAL_MODEL: 7 }))).toEqual({ WEBTERM_CENTRAL: 'on' })
    expect(warns.join()).toContain('WEBTERM_LEDGER')
  })
})
