// v19 caches: a v18 ledger upgrades, keeps its prefix rows, and a re-run of the step is a no-op.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { LATEST_VERSION, migrate } from './migration'
import { MIGRATIONS } from './ledgerSchema'
import { applyV19 } from './ledgerSchemaV19'

test('v18 -> v19 adds tool_cache, embed_cache and prefix.last_used_at; re-run is idempotent', () => {
  const db = new Database(':memory:')
  expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 18))).toBe(18)
  db.exec(`INSERT INTO prefix (id, hash, text, hits, created_at) VALUES ('p1', 'h1', 'sys', 3, 1)`)
  expect(migrate(db)).toBe(LATEST_VERSION)
  for (const t of ['tool_cache', 'embed_cache']) expect(db.query(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)).toBeTruthy()
  const cols = (db.query('PRAGMA table_info(prefix)').all() as { name: string }[]).map((c) => c.name)
  expect(cols).toContain('last_used_at')
  db.exec(`INSERT INTO tool_cache (key, tool, version, result_json, created_at, last_used_at) VALUES ('k', 'repo.map', 'v', '{}', 1, 1)`)
  applyV19(db)
  applyV19(db)
  expect(db.query('SELECT hits FROM prefix WHERE id = ?').get('p1')).toEqual({ hits: 3 })
  expect(db.query('SELECT COUNT(*) AS n FROM tool_cache').get()).toEqual({ n: 1 })
})
