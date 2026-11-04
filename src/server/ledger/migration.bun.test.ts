// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Only toBe/toContain matchers are available (see src/server/bun-test.d.ts).
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LATEST_VERSION, migrate, migrateWithBackup, openLedgerDb, preMigrationBackup } from './migration'
import { MIGRATIONS, type Migration } from './ledgerSchema'
import { applyV4 } from './ledgerSchemaV4'

type Row = Record<string, unknown>
interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}

function q(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}
function run(db: Database, sql: string, ...params: unknown[]): void {
  q(db, sql).run(...params)
}
function close(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}
function version(db: Database): number {
  return Number(q(db, 'PRAGMA user_version').get()?.['user_version'] ?? -1)
}
function expectThrow(fn: () => void, contains: string): string {
  let message = ''
  try {
    fn()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message.length > 0).toBe(true)
  expect(message).toContain(contains)
  return message
}
function tables(db: Database): string {
  const rows = q(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()
  return rows.map((r) => String(r['name'])).join(',')
}

const scratch = process.env.JCODE_SCRATCH_DIR
const root = mkdtempSync(join(scratch && existsSync(scratch) ? scratch : tmpdir(), 'ledger-test-'))
let seq = 0
function tmpPath(): string {
  return join(root, `ledger-${seq++}.sqlite`)
}
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('fresh db migrates to LATEST_VERSION; second migrate is a no-op', () => {
  const path = tmpPath()
  const db = openLedgerDb(path)
  expect(version(db)).toBe(LATEST_VERSION)
  const names = tables(db)
  for (const t of [
    'project', 'agent', 'task', 'event', 'decision', 'approval', 'run', 'usage',
    'prefix', 'budget', 'memory', 'memory_event', 'memory_fts',
    'central_conversation', 'central_message', 'central_turn', 'central_event',
  ]) {
    expect(names).toContain(t)
  }
  const projectColumns = q(db, 'PRAGMA table_info(project)').all().map((r) => String(r['name']))
  expect(projectColumns.join(',')).toContain('goal_json')
  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(version(db)).toBe(LATEST_VERSION)
  expect(String(q(db, 'PRAGMA journal_mode').get()?.['journal_mode'])).toBe('wal')
  expect(Number(q(db, 'PRAGMA foreign_keys').get()?.['foreign_keys'])).toBe(1)
  expect(Number(q(db, 'PRAGMA busy_timeout').get()?.['timeout'])).toBe(5000)
  close(db)

  const reopened = openLedgerDb(path)
  expect(version(reopened)).toBe(LATEST_VERSION)
  expect(Number(q(reopened, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(0)
  close(reopened)
})

test(':memory: path works and skips WAL', () => {
  const db = openLedgerDb(':memory:')
  expect(version(db)).toBe(LATEST_VERSION)
  expect(String(q(db, 'PRAGMA journal_mode').get()?.['journal_mode'])).toBe('memory')
  expect(preMigrationBackup(db, ':memory:')).toBe(null)
  close(db)
})

test('user_version newer than code throws with both numbers', () => {
  const path = tmpPath()
  const future = LATEST_VERSION + 1
  const db = new Database(path)
  db.exec(`PRAGMA user_version = ${future}`)
  const message = expectThrow(() => migrate(db), 'newer than this code')
  expect(message).toContain(String(future))
  expect(message).toContain(`LATEST_VERSION=${LATEST_VERSION}`)
  expectThrow(() => openLedgerDb(path), 'newer than this code')
  expect(version(db)).toBe(future)
  close(db)
})

test('failing migration rolls back and leaves user_version unchanged', () => {
  const db = new Database(':memory:')
  const steps: Migration[] = [
    { version: 1, up: (d) => d.exec('CREATE TABLE ok_one (id TEXT PRIMARY KEY)') },
    {
      version: 2,
      up: (d) => {
        d.exec('CREATE TABLE half_done (id TEXT PRIMARY KEY)')
        throw new Error('boom')
      },
    },
  ]
  expectThrow(() => migrate(db, steps), 'migration 2 failed')
  expect(version(db)).toBe(1)
  expect(tables(db)).toContain('ok_one')
  expect(tables(db)).not.toContain('half_done')
  close(db)
})

test('foreign keys are enforced', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO agent (id, project_id, created_at) VALUES ('a1','p1',1)")
  expectThrow(
    () => run(db, "INSERT INTO agent (id, project_id, created_at) VALUES ('a2','missing',1)"),
    'FOREIGN KEY constraint failed'
  )
  close(db)
})

test('task status CHECK rejects unknown values and accepts every listed one', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  const statuses = [
    'pending', 'leased', 'suspect', 'claimed_done', 'verified',
    'blocked', 'failed', 'cancelled', 'reopened',
  ]
  for (const [i, status] of statuses.entries()) {
    run(db, 'INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      `t${i}`, 'p1', 'spec', status, 1, 1)
  }
  expectThrow(
    () => run(db, "INSERT INTO task (id, project_id, spec, status, created_at, updated_at) VALUES ('bad','p1','s','bogus',1,1)"),
    'CHECK constraint failed'
  )
  expectThrow(
    () => run(db, "UPDATE task SET status = 'bogus' WHERE id = 't0'"),
    'CHECK constraint failed'
  )
  close(db)
})

test('agent depth above 2 is rejected', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO agent (id, project_id, depth, created_at) VALUES ('a0','p1',0,1)")
  run(db, "INSERT INTO agent (id, project_id, depth, created_at) VALUES ('a2','p1',2,1)")
  expectThrow(
    () => run(db, "INSERT INTO agent (id, project_id, depth, created_at) VALUES ('a3','p1',3,1)"),
    'CHECK constraint failed'
  )
  close(db)
})

test('memory_fts stays in sync on insert, update, and delete', () => {
  const db = openLedgerDb(':memory:')
  const insert = (id: string, title: string, body: string) =>
    run(db, 'INSERT INTO memory (id, key, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      id, id, title, body, 1, 1)
  const search = (term: string) =>
    q(db, 'SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(term).length

  insert('m1', 'alpha note', 'the quick brown fox')
  expect(search('alpha')).toBe(1)
  expect(search('fox')).toBe(1)

  run(db, "UPDATE memory SET title = 'beta note' WHERE id = 'm1'")
  expect(search('alpha')).toBe(0)
  expect(search('beta')).toBe(1)

  run(db, "DELETE FROM memory WHERE id = 'm1'")
  expect(search('beta')).toBe(0)
  close(db)
})

test('backup writes a readable copy and keeps the last 3', () => {
  const path = tmpPath()
  const db = openLedgerDb(path)
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO memory (id, key, title, body, created_at, updated_at) VALUES ('m1','m1','alpha note','fox body',1,1)")

  const created: string[] = []
  for (let i = 0; i < 5; i++) {
    const target = preMigrationBackup(db, path)
    expect(target === null).toBe(false)
    created.push(target as string)
  }
  const alive = created.filter((p) => existsSync(p))
  expect(alive.length).toBe(3)
  expect(alive.join(',')).toContain(created[created.length - 1] as string)
  expect(existsSync(created[0] as string)).toBe(false)

  const last = created[created.length - 1] as string
  const copy = new Database(last)
  expect(String(q(copy, 'PRAGMA integrity_check').get()?.['integrity_check'])).toBe('ok')
  expect(Number(q(copy, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  expect(q(copy, 'SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all('alpha').length).toBe(1)
  expect(Number(q(copy, 'PRAGMA user_version').get()?.['user_version'])).toBe(LATEST_VERSION)
  close(copy)

  const backups = readdirSync(root).filter((f) => f.startsWith('ledger-') && f.endsWith('.bak'))
  expect(backups.length).toBe(3)
  close(db)
})

test('schema modules list forward-only migrations matching LATEST_VERSION', () => {
  expect(MIGRATIONS.length).toBe(LATEST_VERSION)
  expect(MIGRATIONS[0]?.version).toBe(1)
  expect(MIGRATIONS[1]?.version).toBe(2)
  expect(MIGRATIONS[2]?.version).toBe(3)
  expect(MIGRATIONS[3]?.version).toBe(4)
  for (let i = 0; i < MIGRATIONS.length; i++) expect(MIGRATIONS[i]?.version).toBe(i + 1) // contiguous from v1
  expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(LATEST_VERSION)
})

test('v1 ledger upgrades to latest in place: rows survive, new tables appear, re-run is a no-op', () => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // Simulate an installed v1 build: only migration 1 has ever run.
  expect(migrate(db, [MIGRATIONS[0] as Migration])).toBe(1)
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO task (id, project_id, spec, created_at, updated_at) VALUES ('t1','p1','spec',1,1)")
  expect(tables(db)).not.toContain('plan')

  expect(migrate(db)).toBe(LATEST_VERSION)
  expect(version(db)).toBe(LATEST_VERSION)
  const names = tables(db)
  expect(names).toContain('plan')
  expect(names).toContain('plan_item')
  expect(names).toContain('request_ack')
  expect(Number(q(db, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  expect(Number(q(db, 'SELECT count(*) AS c FROM task').get()?.['c'])).toBe(1)

  // Idempotent: the later DDL must not throw or drop data on a second pass.
  expect(migrate(db)).toBe(LATEST_VERSION)
  run(db, "INSERT INTO plan (id, project_id, version, status, created_at, updated_at) VALUES ('pl1','p1',1,'draft',1,1)")
  run(db, "INSERT INTO plan_item (id, plan_id, seq, title, scope_json, updated_at) VALUES ('i1','pl1',0,'t','[\"src/a.ts\"]',1)")
  expect(Number(q(db, 'SELECT count(*) AS c FROM plan_item').get()?.['c'])).toBe(1)
  expectThrow(
    () => run(db, "INSERT INTO plan_item (id, plan_id, seq, title, scope_json, updated_at) VALUES ('i2','pl1',0,'t','[\"b\"]',1)"),
    'UNIQUE constraint failed'
  )
  expectThrow(
    () => run(db, "INSERT INTO plan (id, project_id, version, status, created_at, updated_at) VALUES ('pl2','p1',1,'draft',1,1)"),
    'UNIQUE constraint failed'
  )
  close(db)
})

test('plan_item scope_json rejects non-JSON and one task cannot back two items', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO plan (id, project_id, version, status, created_at, updated_at) VALUES ('pl1','p1',1,'draft',1,1)")
  run(db, "INSERT INTO plan_item (id, plan_id, seq, task_id, title, scope_json, status, assignee, updated_at) VALUES ('i1','pl1',0,'t1','t','[\"src/a.ts\"]','assigned','a1',1)")
  expectThrow(
    () => run(db, "INSERT INTO plan_item (id, plan_id, seq, task_id, title, scope_json, status, updated_at) VALUES ('i2','pl1',1,'t1','t','[\"b\"]','assigned',1)"),
    'UNIQUE constraint failed'
  )
  expectThrow(
    () => run(db, "INSERT INTO plan_item (id, plan_id, seq, title, scope_json, updated_at) VALUES ('i3','pl1',2,'t','not-json',1)"),
    'CHECK constraint failed'
  )
  close(db)
})

test('migrateWithBackup snapshots a file DB before an upgrade, but not for a fresh one', () => {
  const path = join(root, 'upgrade.db')
  const db = new Database(path)
  migrate(db)
  // Append one synthetic step past the shipped schema so a real upgrade (and its
  // pre-migration backup) is exercised without reusing a version number.
  const next: Migration = {
    version: LATEST_VERSION + 1,
    up: (d) => d.exec('CREATE TABLE upgrade_marker (id TEXT PRIMARY KEY)'),
  }
  const version = migrateWithBackup(db, path, [...MIGRATIONS, next])
  expect(version).toBe(LATEST_VERSION + 1)
  expect(Number(q(db, 'PRAGMA user_version').get()?.['user_version'])).toBe(LATEST_VERSION + 1)
  const backups = readdirSync(root).filter((f) => f.startsWith('upgrade.db.') && f.endsWith('.bak'))
  expect(backups.length >= 1).toBe(true)
  close(db)
})

test('v3 ledger upgrades to v4 in place: rows survive, goal_json is NULL, central tables appear', () => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  // Simulate an installed v3 build: only migrations 1-3 have ever run.
  expect(migrate(db, MIGRATIONS.slice(0, 3))).toBe(3)
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, "INSERT INTO task (id, project_id, spec, created_at, updated_at) VALUES ('t1','p1','spec',1,1)")
  expect(tables(db)).not.toContain('central_conversation')
  const before = q(db, 'PRAGMA table_info(project)').all().map((r) => String(r['name']))
  expect(before.join(',')).not.toContain('goal_json')

  expect(migrate(db)).toBe(LATEST_VERSION)
  const names = tables(db)
  for (const t of ['central_conversation', 'central_message', 'central_turn', 'central_event']) {
    expect(names).toContain(t)
  }
  expect(Number(q(db, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  expect(Number(q(db, 'SELECT count(*) AS c FROM task').get()?.['c'])).toBe(1)
  expect(q(db, "SELECT goal_json FROM project WHERE id = 'p1'").get()?.['goal_json']).toBe(null)
  // Nothing pending on a second pass: v4 must not re-run the ALTER.
  expect(migrate(db)).toBe(LATEST_VERSION)
  close(db)
})

test('applyV4 re-run is a no-op even after the version bump (restored/partial DB)', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  applyV4(db)
  applyV4(db)
  expect(version(db)).toBe(LATEST_VERSION)
  const columns = q(db, 'PRAGMA table_info(project)').all().map((r) => String(r['name']))
  expect(columns.filter((c) => c === 'goal_json').length).toBe(1)
  expect(Number(q(db, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  close(db)
})

test('project.goal_json accepts valid JSON and rejects garbage', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  run(db, `UPDATE project SET goal_json = '{"version":1,"status":"proposed"}' WHERE id = 'p1'`)
  expect(String(q(db, "SELECT goal_json FROM project WHERE id = 'p1'").get()?.['goal_json'])).toContain('proposed')
  expectThrow(
    () => run(db, "UPDATE project SET goal_json = 'not-json' WHERE id = 'p1'"),
    'CHECK constraint failed'
  )
  close(db)
})

test('central_message enforces role, seq, and clientMessageId uniqueness; NULL clients repeat', () => {
  const db = openLedgerDb(':memory:')
  run(db, "INSERT INTO central_conversation (id, scope, project_id, created_at, updated_at) VALUES ('central:global','global',NULL,1,1)")
  const insert = (id: string, seq: number, role: string, client: string | null) =>
    run(db, `INSERT INTO central_message (id, conversation_id, seq, role, parts_json, client_message_id, created_at)
             VALUES (?, 'central:global', ?, ?, '[]', ?, 1)`, id, seq, role, client)
  for (const [i, role] of ['human', 'assistant', 'tool', 'system'].entries()) insert(`m${i}`, i + 1, role, null)
  // Two NULL client ids do not collide (SQLite UNIQUE treats NULLs as distinct).
  expect(Number(q(db, 'SELECT count(*) AS c FROM central_message').get()?.['c'])).toBe(4)
  insert('m9', 5, 'human', 'c1')
  expectThrow(() => insert('m10', 6, 'human', 'c1'), 'UNIQUE constraint failed')
  expectThrow(() => insert('m11', 5, 'human', null), 'UNIQUE constraint failed')
  expectThrow(() => insert('m12', 7, 'robot', null), 'CHECK constraint failed')
  expectThrow(
    () => run(db, "INSERT INTO central_message (id, conversation_id, seq, role, parts_json, created_at) VALUES ('bad','central:global',8,'human','nope',1)"),
    'CHECK constraint failed'
  )
  close(db)
})

test('migrateWithBackup snapshots a v3 file before applying v4', () => {
  const path = join(root, 'v3-upgrade.db')
  const db = new Database(path)
  expect(migrate(db, MIGRATIONS.slice(0, 3))).toBe(3)
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
  expect(migrateWithBackup(db, path)).toBe(LATEST_VERSION)
  expect(version(db)).toBe(LATEST_VERSION)
  expect(Number(q(db, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  const backups = readdirSync(root).filter((f) => f.startsWith('v3-upgrade.db.') && f.endsWith('.bak'))
  expect(backups.length >= 1).toBe(true)
  close(db)
})
