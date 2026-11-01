// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Guards for the P2 correctness findings: connection pragmas, parent/project
// invariants, event references, pagination bounds, and migration safety.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, preMigrationBackup } from './migration'
import type { Migration } from './ledgerSchema'
import { DuplicateIdemKeyError, LedgerError, LedgerNotFoundError, createLedger, type Ledger } from './ledger'

type Row = Record<string, unknown>
declare const Bun: {
  spawn(cmd: string[], opts?: { stdout?: 'ignore'; stderr?: 'ignore' }): { exited: Promise<number> }
}
interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}

function q(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}
function one(db: Database, sql: string, ...params: unknown[]): Row | null {
  return q(db, sql).get(...params)
}
function count(db: Database, table: string, where = '', ...params: unknown[]): number {
  const sql = `SELECT count(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ''}`
  return Number(one(db, sql, ...params)?.['c'] ?? -1)
}
function pragma(db: Database, name: string): number {
  const row = one(db, `PRAGMA ${name}`)
  return row === null ? NaN : Number(Object.values(row)[0])
}
function close(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}
function expectThrow(fn: () => unknown, contains: string): Error {
  try {
    fn()
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    expect(error.message).toContain(contains)
    return error
  }
  throw new Error(`expected a throw containing: ${contains}`)
}

const scratch = process.env.JCODE_SCRATCH_DIR
const root = mkdtempSync(join(scratch && existsSync(scratch) ? scratch : tmpdir(), 'ledger-guard-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const T0 = 1_700_000_000_000

interface Fixture {
  db: Database
  ledger: Ledger
}

/** Raw connection with no pragmas, exactly like Bun's default hand-off. */
function fixture(): Fixture {
  const db = new Database(':memory:')
  const ledger = createLedger(db, { now: T0 })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'p1', path: '/tmp/p1' })
  ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'p2', path: '/tmp/p2' })
  return { db, ledger }
}

test('H3: createLedger enables FK + busy_timeout on a bare connection, so delete cascades', () => {
  const { db, ledger } = fixture()
  expect(pragma(db, 'foreign_keys')).toBe(1)
  expect(pragma(db, 'busy_timeout')).toBe(5000)

  ledger.agent.createAgent({ id: 'a0', projectId: 'p1', depth: 0 })
  ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 'work' })
  ledger.event.appendEvent({ projectId: 'p1', taskId: 't1', actor: 'test', kind: 'k' })
  expect(count(db, 'agent')).toBe(1)
  expect(count(db, 'task')).toBe(1)
  // task.created plus the explicit event.
  expect(count(db, 'event', 'project_id = ?', 'p1')).toBe(2)

  expect(ledger.deleteProject('p1')).toBe(true)
  expect(count(db, 'project')).toBe(1) // p2 stays
  expect(ledger.project.getProject('p1')).toBe(null)
  for (const table of ['agent', 'task', 'event']) {
    expect(`${table}=${count(db, table)}`).toBe(`${table}=0`)
  }
  expect(ledger.deleteProject('p1')).toBe(false)
  close(db)
})

test('H3: createLedger refuses a connection where the pragma cannot be applied', () => {
  const db = new Database(':memory:')
  db.exec('BEGIN')
  const err = expectThrow(() => createLedger(db), 'PRAGMA foreign_keys reads back 0')
  expect(err instanceof LedgerError).toBe(true)
  db.exec('ROLLBACK')
  close(db)
})

test('M2: agent depth is derived from the parent and cannot be forged', () => {
  const { db, ledger } = fixture()
  ledger.agent.createAgent({ id: 'a0', projectId: 'p1', depth: 0 })
  const child = ledger.agent.createAgent({ id: 'a1', projectId: 'p1', parentAgentId: 'a0', depth: 1 })
  expect(child.depth).toBe(1)

  expectThrow(
    () => ledger.agent.createAgent({ projectId: 'p1', parentAgentId: 'a0', depth: 0 }),
    'agent.depth must be 1 (parent a0 + 1), got 0'
  )
  expectThrow(
    () => ledger.agent.createAgent({ projectId: 'p2', parentAgentId: 'a0', depth: 1 }),
    'belongs to project p1, not p2'
  )
  const missing = expectThrow(
    () => ledger.agent.createAgent({ projectId: 'p1', parentAgentId: 'ghost', depth: 1 }),
    'agent not found: ghost'
  )
  expect(missing instanceof LedgerNotFoundError).toBe(true)
  expect(count(db, 'agent')).toBe(2)
  close(db)
})

test('M2: task parents and agents must belong to the task project', () => {
  const { db, ledger } = fixture()
  ledger.agent.createAgent({ id: 'a1', projectId: 'p1', depth: 0 })
  ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 'parent' })

  ledger.task.createTask({ id: 't2', projectId: 'p1', parentId: 't1', agentId: 'a1', spec: 'child' })
  expectThrow(
    () => ledger.task.createTask({ projectId: 'p2', parentId: 't1', spec: 'x' }),
    'task.parentId t1 belongs to project p1, not p2'
  )
  expectThrow(
    () => ledger.task.createTask({ projectId: 'p2', agentId: 'a1', spec: 'x' }),
    'task.agentId a1 belongs to project p1, not p2'
  )
  expectThrow(
    () => ledger.task.createTask({ projectId: 'p1', parentId: 'ghost', spec: 'x' }),
    'task not found: ghost'
  )
  expectThrow(
    () => ledger.task.createTask({ projectId: 'p1', agentId: 'ghost', spec: 'x' }),
    'agent not found: ghost'
  )
  expect(count(db, 'task')).toBe(2)
  close(db)
})

test('M3: appendEvent rejects cross-project pairs and dangling references', () => {
  const { db, ledger } = fixture()
  ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 'work' })
  const before = count(db, 'event')

  const mismatch = expectThrow(
    () => ledger.event.appendEvent({ projectId: 'p2', taskId: 't1', actor: 'test', kind: 'k' }),
    'event projectId p2 disagrees with task t1 (project p1)'
  )
  expect(mismatch instanceof LedgerError).toBe(true)
  expect(mismatch instanceof LedgerNotFoundError).toBe(false)

  const noTask = expectThrow(
    () => ledger.event.appendEvent({ taskId: 'ghost', actor: 'test', kind: 'k' }),
    'task not found: ghost'
  )
  expect(noTask instanceof LedgerNotFoundError).toBe(true)

  const noProject = expectThrow(
    () => ledger.event.appendEvent({ projectId: 'ghost', actor: 'test', kind: 'k' }),
    'project not found: ghost'
  )
  expect(noProject instanceof LedgerNotFoundError).toBe(true)

  expectThrow(
    () => ledger.event.appendEvent({ runId: 'ghost', actor: 'test', kind: 'k' }),
    'run not found: ghost'
  )
  expect(count(db, 'event')).toBe(before)

  // A task-only event is still legal (project inferred as NULL).
  const ok = ledger.event.appendEvent({ taskId: 't1', actor: 'test', kind: 'ok' })
  expect(ok.projectId).toBe(null)
  close(db)
})

test('M1: idem_key uniqueness is per project', () => {
  const { db, ledger } = fixture()
  const a = ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 's', idemKey: 'create:1' })
  const b = ledger.task.createTask({ id: 't2', projectId: 'p2', spec: 's', idemKey: 'create:1' })
  expect(`${a.idemKey}/${b.idemKey}`).toBe('create:1/create:1')

  const dup = (() => {
    try {
      ledger.task.createTask({ id: 't3', projectId: 'p1', spec: 's', idemKey: 'create:1' })
    } catch (err) {
      return err
    }
    return null
  })()
  expect(dup instanceof DuplicateIdemKeyError).toBe(true)
  expect(count(db, 'task')).toBe(2)
  close(db)
})

test('M4: non-finite list options are typed caller errors', () => {
  const { db, ledger } = fixture()
  ledger.event.appendEvent({ projectId: 'p1', actor: 'test', kind: 'k' })
  expectThrow(
    () => ledger.event.listEvents({ limit: Number.NaN }),
    'limit must be a positive number'
  )
  expectThrow(
    () => ledger.event.listEvents({ limit: 'abc' as unknown as number }),
    'limit must be a positive number'
  )
  expectThrow(
    () => ledger.project.listProjects({ limit: Number.NaN }),
    'listProjects: limit must be a positive number'
  )
  close(db)
})

test('M5: list-query indexes exist and are used by the planner', () => {
  const { db } = fixture()
  const indexes = q(db, "SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => String(r['name']))
    .join(',')
  for (const name of [
    'idx_event_task_seq',
    'idx_event_project_seq',
    'idx_task_project_created',
    'uq_task_project_idem',
  ]) {
    expect(indexes).toContain(name)
  }
  const plan = (sql: string): string =>
    q(db, `EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => String(r['detail'] ?? ''))
      .join(' | ')
  expect(plan("SELECT * FROM event WHERE task_id = 't1' ORDER BY seq")).toContain('idx_event_task_seq')
  expect(plan("SELECT * FROM event WHERE project_id = 'p1' ORDER BY seq")).toContain(
    'idx_event_project_seq'
  )
  expect(plan("SELECT * FROM task WHERE project_id = 'p1' ORDER BY created_at, id")).toContain(
    'idx_task_project_created'
  )
  close(db)
})

test('L10: listProjects paginates with finite clamping', () => {
  const { db, ledger } = fixture()
  ledger.project.createProject({ id: 'p3', workspaceId: 'w3', name: 'p3', path: '/tmp/p3' })
  expect(ledger.project.listProjects().length).toBe(3)
  expect(ledger.project.listProjects({ limit: 2 }).length).toBe(2)
  expect(ledger.project.listProjects({ limit: 2, offset: 2 }).length).toBe(1)
  expect(ledger.project.listProjects({ limit: 5000 }).length).toBe(3)
  expectThrow(
    () => ledger.project.listProjects({ offset: -1 }),
    'listProjects: offset must be a non-negative number'
  )
  close(db)
})

test('L7: project and agent text fields are required and workspace clashes are typed', () => {
  const { db, ledger } = fixture()
  expectThrow(
    () => ledger.project.createProject({ workspaceId: '', name: 'n', path: '/p' }),
    'project.workspaceId must be a non-empty string'
  )
  expectThrow(
    () => ledger.project.createProject({ workspaceId: 'w9', name: '  ', path: '/p' }),
    'project.name must be a non-empty string'
  )
  expectThrow(
    () => ledger.project.createProject({ workspaceId: 'w9', name: 'n', path: '' }),
    'project.path must be a non-empty string'
  )
  const dup = expectThrow(
    () => ledger.project.createProject({ id: 'p9', workspaceId: 'w1', name: 'n', path: '/p' }),
    'project.workspaceId already has a ledger project: w1'
  )
  expect(dup instanceof LedgerError).toBe(true)
  expectThrow(
    () => ledger.agent.createAgent({ projectId: ' ', depth: 0 }),
    'agent.projectId must be a non-empty string'
  )
  expectThrow(
    () => ledger.agent.createAgent({ projectId: 'p1', depth: 0, name: '' }),
    'agent.name must be a non-empty string'
  )
  expect(count(db, 'project')).toBe(2)
  close(db)
})

test('L2: preMigrationBackup refuses to run inside a transaction', () => {
  const db = new Database(':memory:')
  db.exec('BEGIN')
  const err = expectThrow(() => preMigrationBackup(db, ':memory:'), 'cannot run inside a transaction')
  expect(err instanceof LedgerError).toBe(true)
  db.exec('ROLLBACK')
  close(db)
})

test('L4/L5: migration versions must be positive, unique, and increasing', () => {
  const db = new Database(':memory:')
  const noop = (): void => {}
  const dup: Migration[] = [
    { version: 2, up: noop },
    { version: 2, up: noop },
  ]
  const dupErr = expectThrow(() => migrate(db, dup), 'must be strictly increasing')
  expect(dupErr instanceof LedgerError).toBe(true)
  expect(pragma(db, 'user_version')).toBe(0)

  for (const version of [0, -1, 1.5, Number.NaN]) {
    expectThrow(
      () => migrate(db, [{ version, up: noop }]),
      'migration version must be a positive integer'
    )
  }
  expect(pragma(db, 'user_version')).toBe(0)
  expect(String(one(db, "SELECT name FROM sqlite_master WHERE type='table'") ?? '')).toBe('')
  close(db)
})

test('workspace delete removes only that workspace projects and keeps the other intact', () => {
  const { db, ledger } = fixture()
  ledger.agent.createAgent({ id: 'a1', projectId: 'p1', depth: 0 })
  ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 'work' })
  ledger.task.createTask({ id: 't2', projectId: 'p2', spec: 'other' })

  expect(ledger.deleteProjectsForWorkspace('w1')).toBe(1)
  expect(ledger.project.getProject('p1')).toBe(null)
  expect(ledger.project.getProject('p2')).not.toBe(null)
  expect(count(db, 'task', 'project_id = ?', 'p1')).toBe(0)
  expect(count(db, 'agent', 'project_id = ?', 'p1')).toBe(0)
  expect(count(db, 'task', 'project_id = ?', 'p2')).toBe(1)
  expect(ledger.deleteProjectsForWorkspace('w1')).toBe(0)
})

test('crash mid-transaction leaves no half-written ledger rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-crash-'))
  const file = join(dir, 'ledger.db')
  const seed = new Database(file)
  migrate(seed)
  close(seed)

  const script = `
    import { Database } from 'bun:sqlite'
    const db = new Database(process.argv[2])
    db.exec('BEGIN IMMEDIATE')
    db.exec("INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('half','w','n','/tmp',1,1)")
    process.kill(process.pid, 'SIGKILL')
  `
  const proc = Bun.spawn(['bun', '-e', script, file], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited

  const check = new Database(file)
  try {
    expect(count(check, 'project')).toBe(0)
    expect(pragma(check, 'user_version')).toBe(1)
  } finally {
    close(check)
    rmSync(dir, { recursive: true, force: true })
  }
})
