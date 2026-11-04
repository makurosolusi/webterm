// Bun-only (needs bun:sqlite). CA2 migrations v5..v9 on a real v4 file DB. See migration.bun.test.ts for helpers' origin.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { LATEST_VERSION, migrateWithBackup, openLedgerDb } from './migration'
import { MIGRATIONS } from './ledgerSchema'
import { DDL_EVENT_IMMUTABLE } from './ledgerSchemaV9'

type Row = Record<string, unknown>
interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}
const q = (db: Database, sql: string): Stmt => db.query(sql) as unknown as Stmt
const close = (db: Database): void => (db as unknown as { close(): void }).close()
const userVersion = (db: Database): number => Number(q(db, 'PRAGMA user_version').get()?.['user_version'])
const count = (db: Database, sql: string): number => Number(q(db, sql).get()?.['c'])
function columns(db: Database, table: string): string {
  return q(db, `PRAGMA table_info(${table})`).all().map((r) => String(r['name'])).join(',')
}
function throwsWith(fn: () => void): string {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return ''
}

const scratch = process.env.JCODE_SCRATCH_DIR
const root = mkdtempSync(join(scratch && existsSync(scratch) ? scratch : tmpdir(), 'ledger-ca2-'))
let seq = 0
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MEM = 'INSERT INTO memory (id, project_id, scope, key, title, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'

/** File DB frozen at v4 with legacy rows: NULL-project duplicates, a fact, one project with an event. */
function seedV4(): { db: Database; path: string } {
  const path = join(root, `ledger-${seq++}.sqlite`)
  const db = new Database(path)
  db.exec('PRAGMA foreign_keys = ON')
  migrateWithBackup(db, path, MIGRATIONS.filter((m) => m.version <= 4))
  q(db, MEM).run('m1', null, 'user', 'lang', 'old', 'bahasa lama', 'claim', 1, 10)
  q(db, MEM).run('m2', null, 'user', 'lang', 'new', 'bahasa baru', 'fact', 2, 20)
  q(db, MEM).run('m3', null, 'user', 'lang', 'mid', 'bahasa tengah', 'claim', 3, 15)
  q(db, MEM).run('m4', null, 'user', 'solo', 'solo', 'sendiri', 'claim', 4, 30)
  q(db, MEM).run('m5', null, 'user', 'lang', 'gone', 'sudah usang', 'superseded', 5, 5)
  q(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','n','/p',1,1)").run()
  q(db, "INSERT INTO event (ts, project_id, actor, kind) VALUES (1,'p1','test','seed')").run()
  expect(userVersion(db)).toBe(4)
  return { db, path }
}

test('v4 -> latest migrates with a backup, keeps data, and a second run is a no-op', () => {
  const { db, path } = seedV4()
  expect(LATEST_VERSION).toBe(MIGRATIONS.at(-1)!.version)
  expect(migrateWithBackup(db, path)).toBe(LATEST_VERSION)
  const backups = readdirSync(root).filter((f) => f.startsWith(`${basename(path)}.`) && f.endsWith('.v4.bak'))
  expect(backups.length).toBe(1)
  close(db)

  const again = openLedgerDb(path)
  expect(userVersion(again)).toBe(LATEST_VERSION)
  expect(readdirSync(root).filter((f) => f.startsWith(`${basename(path)}.`) && f.endsWith('.bak')).length).toBe(1)
  for (const m of MIGRATIONS.filter((x) => x.version >= 5)) m.up(again) // every up() must itself be re-runnable
  expect(count(again, 'SELECT count(*) AS c FROM memory')).toBe(5)
  expect(count(again, 'SELECT count(*) AS c FROM event')).toBe(1)
  const tables = q(again, "SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r['name'])).join(',')
  for (const t of ['central_control', 'central_breaker', 'central_budget', 'central_agents', 'agent_mail', 'memory_embedding', 'memory_fts_tri', 'central_checkpoint']) {
    expect(tables).toContain(t)
  }
  expect(columns(again, 'memory')).toContain('trust')
  expect(columns(again, 'memory')).toContain('links_json')
  expect(columns(again, 'central_turn')).toContain('ctx_tokens')
  expect(columns(again, 'event')).toContain('prev_hash')
  expect(columns(again, 'event')).toContain('hash')
  close(again)
})

test('v7 dedupes NULL-project memory keeping the newest, backfills trust, indexes trigram FTS', () => {
  const { db, path } = seedV4()
  migrateWithBackup(db, path)
  const status = (id: string): string => String(q(db, 'SELECT status FROM memory WHERE id = ?').get(id)?.['status'])
  expect(status('m2')).toBe('fact')
  expect(status('m1')).toBe('superseded')
  expect(status('m3')).toBe('superseded')
  expect(status('m4')).toBe('claim')
  expect(String(q(db, "SELECT key FROM memory WHERE id = 'm2'").get()?.['key'])).toBe('lang')
  expect(String(q(db, "SELECT key FROM memory WHERE id = 'm1'").get()?.['key'])).toContain('#superseded-m1')
  expect(count(db, "SELECT count(*) AS c FROM memory WHERE key = 'lang'")).toBe(1)
  // Backfill: legacy fact -> human; claims keep the safe default.
  expect(String(q(db, "SELECT trust FROM memory WHERE id = 'm2'").get()?.['trust'])).toBe('human')
  expect(String(q(db, "SELECT trust FROM memory WHERE id = 'm4'").get()?.['trust'])).toBe('agent')
  expect(String(q(db, "SELECT kind FROM memory WHERE id = 'm4'").get()?.['kind'])).toBe('fact')
  // Unique key now enforced for NULL project too.
  expect(throwsWith(() => q(db, MEM).run('m6', null, 'user', 'lang', 't', 'b', 'claim', 9, 9))).toContain('UNIQUE')
  // Trigram FTS: rebuilt for old rows and kept in sync by the trigger for new ones.
  expect(count(db, "SELECT count(*) AS c FROM memory_fts_tri WHERE memory_fts_tri MATCH 'tengah'")).toBe(1)
  q(db, MEM).run('m7', 'p1', 'project', 'k', 'judul', 'kalimat unik zebra', 'claim', 9, 9)
  expect(count(db, "SELECT count(*) AS c FROM memory_fts_tri WHERE memory_fts_tri MATCH 'zebra'")).toBe(1)
  // A re-run must not re-trust rows written after the first run.
  q(db, "UPDATE memory SET trust = 'agent' WHERE id = 'm2'").run()
  for (const m of MIGRATIONS.filter((x) => x.version === 7)) m.up(db)
  expect(String(q(db, "SELECT trust FROM memory WHERE id = 'm2'").get()?.['trust'])).toBe('agent')
  close(db)
})

test('v5/v6/v8 constraints reject invalid rows', () => {
  const db = openLedgerDb(':memory:')
  const reject = (sql: string): void => expect(throwsWith(() => q(db, sql).run())).toContain('CHECK')
  q(db, "INSERT INTO central_control (scope, level, set_by, set_at) VALUES ('global','propose','t',1)").run()
  reject("INSERT INTO central_control (scope, level, set_by, set_at) VALUES ('global2','off','t',1)")
  reject("INSERT INTO central_control (scope, level, set_by, set_at) VALUES ('project:a','root','t',1)")
  reject("INSERT INTO central_breaker (key) VALUES ('other:x')")
  reject("INSERT INTO central_agents (id, project_id, kind, runner, state, owner, started_at) VALUES ('a','p','k','pty','requested','bogus',1)")
  q(db, "INSERT INTO central_agents (id, project_id, kind, runner, state, owner, req_id, started_at) VALUES ('a','p','k','exec','requested','central:c1','r1',1)").run()
  expect(throwsWith(() => q(db, "INSERT INTO central_agents (id, project_id, kind, runner, state, owner, req_id, started_at) VALUES ('b','p','k','exec','requested','human','r1',1)").run())).toContain('UNIQUE')
  reject("INSERT INTO agent_mail (id, project_id, from_ref, to_ref, kind, body, created_at) VALUES ('m','p','a','b','shout','x',1)")
  reject(`INSERT INTO central_checkpoint (id, conversation_id, seq, facts_json, narrative, source, created_at) VALUES ('c','v',1,'{}','${'x'.repeat(1501)}','auto',1)`)
  q(db, "INSERT INTO central_checkpoint (id, conversation_id, seq, facts_json, narrative, source, created_at) VALUES ('c','v',1,'{}','ok','auto',1)").run()
  expect(throwsWith(() => q(db, "INSERT INTO central_checkpoint (id, conversation_id, seq, facts_json, narrative, source, created_at) VALUES ('d','v',1,'{}','ok','manual',1)").run())).toContain('UNIQUE')
  close(db)
})

test('v9 omits the append-only trigger because deleteProject cascades into event; the DDL works when enabled', () => {
  const { db, path } = seedV4()
  migrateWithBackup(db, path)
  expect(count(db, "SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'event_no_%'")).toBe(0)
  db.exec(DDL_EVENT_IMMUTABLE)
  expect(throwsWith(() => q(db, "UPDATE event SET kind = 'x'").run())).toContain('append-only')
  expect(throwsWith(() => q(db, 'DELETE FROM event').run())).toContain('append-only')
  // The blocker recorded in ledgerSchemaV9.ts: removing a project cascades DELETE into event.
  expect(throwsWith(() => q(db, "DELETE FROM project WHERE id = 'p1'").run())).toContain('append-only')
  expect(count(db, 'SELECT count(*) AS c FROM event')).toBe(1)
  close(db)
})
