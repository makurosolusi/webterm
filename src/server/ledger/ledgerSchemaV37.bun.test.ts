// v37: connectivity_episode is created once, re-applying keeps rows, and a fresh db reaches LATEST_VERSION with it.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { LATEST_VERSION, migrate } from './migration'
import { applyV37 } from './ledgerSchemaV37'

test('creates the table from v36, is idempotent and keeps rows', () => {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 36))
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'connectivity_episode'").all()).toEqual([])
  expect(migrate(db)).toBe(LATEST_VERSION)
  db.query("INSERT INTO connectivity_episode (id, state, started_at, cause, scope) VALUES ('e1', 'offline', 5, 'dns', 'network')").run()
  applyV37(db)
  applyV37(db)
  expect(db.query('SELECT id, ended_at AS e FROM connectivity_episode').all()).toEqual([{ id: 'e1', e: null }])
})
