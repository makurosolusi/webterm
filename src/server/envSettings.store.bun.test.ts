// Bun-only: store override di atas bun:sqlite sungguhan lewat openDb, berdampingan dengan baris settings.
import { test, expect } from 'bun:test'
import { Db, openDb } from './db'
import { createAppRowOverrideStore } from './envSettings.store'

test('baris env_overrides round-trip dan tidak mengganggu settings', () => {
  const raw = openDb(':memory:')
  const db = new Db(raw)
  const before = db.saveSettings({ scrollbackBytes: 4321 })
  const store = createAppRowOverrideStore(raw)
  expect(store.load()).toBe(null)
  store.save('{"WEBTERM_CENTRAL":"on"}')
  expect(store.load()).toBe('{"WEBTERM_CENTRAL":"on"}')
  expect(JSON.stringify(db.getSettings())).toBe(JSON.stringify(before))
})
