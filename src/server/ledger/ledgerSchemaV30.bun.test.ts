// v30: health findings and scans are additive, re-applying is a no-op, and they go with their project.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './ledgerSchema'
import { RETENTION } from './ledgerRetention.policy'
import { LATEST_VERSION, migrate } from './migration'
import { applyV30 } from './ledgerSchemaV30'

/** The thrown error as `Name: message` (the local bun:test typings have no toThrow). */
const thrown = (fn: () => unknown): string => { try { fn() } catch (err) { return err instanceof Error ? `${err.name}: ${err.message}` : String(err) } return 'did not throw' }

const DAY = 86_400_000
const count = (db: Database, table: string): number => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const finding = (id: string, fp: string, status = 'open', fixedAt: number | null = null) =>
  `INSERT INTO central_finding (id, project_id, fingerprint, origin, rule, severity, confidence, file, title, evidence, source, suggestion, status, first_seen_at, last_seen_at, fixed_at)
   VALUES ('${id}', 'p', '${fp}', 'scan', 'file_size', 'high', 'high', 'a.ts', 't', 'e', 's', 'x', '${status}', 0, 0, ${fixedAt ?? 'NULL'})`

function migrated(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, MIGRATIONS.filter((m) => m.version <= 29))
  expect(migrate(db)).toBe(LATEST_VERSION)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  return db
}

test('applying v30 twice keeps the rows', () => {
  const db = migrated()
  db.exec(finding('f', 'fp'))
  db.exec(`INSERT INTO central_health_scan (id, project_id, origin, started_at) VALUES ('s', 'p', 'scan', 0)`)
  applyV30(db)
  expect(count(db, 'central_finding')).toBe(1)
  expect(count(db, 'central_health_scan')).toBe(1)
})

test('one finding per project and fingerprint; status outside the three values is refused', () => {
  const db = migrated()
  db.exec(finding('a', 'fp'))
  expect(thrown(() => db.exec(finding('b', 'fp')))).not.toBe('did not throw')
  expect(thrown(() => db.exec(finding('c', 'other', 'done')))).not.toBe('did not throw')
})

test('deleting the project removes its findings and scans', () => {
  const db = migrated()
  db.exec(finding('f', 'fp'))
  db.exec(`INSERT INTO central_health_scan (id, project_id, origin, started_at) VALUES ('s', 'p', 'scan', 0)`)
  db.exec(`DELETE FROM project WHERE id = 'p'`)
  expect(count(db, 'central_finding')).toBe(0)
  expect(count(db, 'central_health_scan')).toBe(0)
})

test('retention drops old fixed findings and superseded scans, keeps dismissed findings and the latest scan', () => {
  const db = migrated()
  const ctx = { db, now: () => 100 * DAY }
  db.exec(finding('fixed', 'a', 'fixed', 1))
  db.exec(finding('dismissed', 'b', 'dismissed'))
  db.exec(finding('open', 'c'))
  db.exec(`INSERT INTO central_health_scan (id, project_id, origin, status, started_at) VALUES ('old', 'p', 'scan', 'done', 1), ('last', 'p', 'scan', 'done', 2), ('rev', 'p', 'review', 'done', 1)`)
  for (const table of ['central_finding', 'central_health_scan']) {
    const entry = RETENTION[table]
    if (entry?.kind !== 'sweep') throw new Error(`${table} has no sweep`)
    expect(entry.sweep(ctx, ctx.now(), 10)).toBe(1)
  }
  expect((db.query('SELECT id FROM central_finding ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual(['dismissed', 'open'])
  expect((db.query('SELECT id FROM central_health_scan ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual(['last', 'rev'])
})
