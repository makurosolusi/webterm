// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Only toBe/toContain matchers are available (see src/server/bun-test.d.ts).
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LATEST_VERSION, migrateWithBackup, openLedgerDb } from './migration'
import { MIGRATIONS, type Migration } from './ledgerSchema'

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
function mode(file: string): number {
  return statSync(file).mode & 0o777
}
/** No group or other access bits: readable/writable by the owner only. */
function isPrivate(file: string): boolean {
  return (statSync(file).mode & 0o077) === 0
}

const scratch = process.env.JCODE_SCRATCH_DIR
const root = mkdtempSync(join(scratch && existsSync(scratch) ? scratch : tmpdir(), 'ledger-perm-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A fresh world-traversable directory, so the umask default (0644) is visible. */
function publicDir(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  chmodSync(dir, 0o755)
  return dir
}

test('openLedgerDb hardens a file DB and its WAL sidecars to 0600', () => {
  const dir = publicDir('open-')
  expect(mode(dir)).toBe(0o755)

  const path = join(dir, 'ledger.db')
  const db = openLedgerDb(path)
  try {
    // Mode is asserted, not just "not world writable": 0644 would still leak payloads.
    expect(mode(path)).toBe(0o600)
    expect(isPrivate(path)).toBe(true)
    // WAL is on for file DBs, so the sidecars normally exist right after migrate.
    const sidecars = [`${path}-wal`, `${path}-shm`].filter((f) => existsSync(f))
    for (const sidecar of sidecars) {
      expect(mode(sidecar)).toBe(0o600)
      expect(isPrivate(sidecar)).toBe(true)
    }
    // The handle must still be usable after the chmod.
    run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp',1,1)")
    expect(Number(q(db, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
  } finally {
    close(db)
  }
})

test('preMigrationBackup leaves a 0600 copy before a pending upgrade', () => {
  const dir = publicDir('backup-')
  expect(mode(dir)).toBe(0o755)

  const path = join(dir, 'ledger.db')
  // Simulate an installed v1 build: only migration 1 has run, with real rows in it.
  const seeded = new Database(path)
  migrateWithBackup(seeded, path, [MIGRATIONS[0] as Migration])
  run(seeded, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','proj','/tmp',1,1)")
  close(seeded)
  const seededCheck = new Database(path)
  expect(String(q(seededCheck, 'PRAGMA user_version').get()?.['user_version'])).toBe('1')
  close(seededCheck)

  const db = new Database(path)
  let backups: string[] = []
  try {
    expect(migrateWithBackup(db, path)).toBe(LATEST_VERSION)
    backups = readdirSync(dir).filter((f) => f.startsWith('ledger.db.') && f.endsWith('.bak'))
  } finally {
    close(db)
  }
  expect(backups.length).toBe(1)
  const backup = join(dir, backups[0] as string)

  // The copy is a full ledger snapshot: same default umask as the main db, so
  // without the explicit chmod this is 0644.
  expect(mode(backup)).toBe(0o600)
  expect(isPrivate(backup)).toBe(true)

  const copy = new Database(backup)
  try {
    expect(String(q(copy, 'PRAGMA integrity_check').get()?.['integrity_check'])).toBe('ok')
    expect(String(q(copy, 'PRAGMA user_version').get()?.['user_version'])).toBe('1')
    expect(Number(q(copy, 'SELECT count(*) AS c FROM project').get()?.['c'])).toBe(1)
    expect(String(q(copy, "SELECT name FROM project WHERE id = 'p1'").get()?.['name'])).toBe('proj')
  } finally {
    close(copy)
  }
})
