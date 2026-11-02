// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Only toBe/toContain matchers are typed (see src/server/bun-test.d.ts).
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openLedgerDb } from '../ledger/migration'
import { abandonGoal, activateGoal, getGoal, proposeGoal } from './goalStore'

type Row = Record<string, unknown>
interface Stmt {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | null
  run(...params: unknown[]): unknown
}
function q(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}
function close(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}
function count(db: Database, table: string): number {
  return Number(q(db, `SELECT count(*) AS c FROM ${table}`).get()?.['c'] ?? -1)
}
function expectThrow(fn: () => unknown, contains: string): void {
  let message = ''
  try {
    fn()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message.length > 0).toBe(true)
  expect(message).toContain(contains)
}
function freshDb(): Database {
  const db = openLedgerDb(':memory:')
  q(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','Proj','/tmp/p1',1,1)").run()
  return db
}
const draft = {
  statement: 'Ship the central slice',
  successCriteria: [
    { kind: 'command', command: 'npm test' },
    { kind: 'scope', paths: ['src/server/central'] },
    { kind: 'review', by: 'human' },
  ],
  owner: 'human:root',
  horizon: '2026-11-30',
  envelope: { maxCostMicros: 5_000_000, maxWallMs: 1_800_000, maxItems: 40 },
}
const central = { id: 'central-1', kind: 'central' }
const human = { id: 'alice', kind: 'human' }

test('propose writes a versioned proposed goal and one audit event with no plan/task effect', () => {
  const db = freshDb()
  expect(getGoal(db, 'p1')).toBe(null)
  const goal = proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: null, now: 100 })
  expect(goal.version).toBe(1)
  expect(goal.status).toBe('proposed')
  expect(goal.successCriteria.length).toBe(3)
  expect(JSON.stringify(getGoal(db, 'p1'))).toBe(JSON.stringify(goal))
  expect(count(db, 'plan')).toBe(0)
  expect(count(db, 'task')).toBe(0)
  expect(String(q(db, "SELECT status FROM project WHERE id = 'p1'").get()?.['status'])).toBe('active')
  const event = q(db, 'SELECT actor, kind, payload_json FROM event ORDER BY seq').all()[0] as Row
  expect(String(event['actor'])).toBe('central-1')
  expect(String(event['kind'])).toBe('goal.proposed')
  expect(String(event['payload_json'])).toContain('"toVersion":1')
  expect(Number(q(db, 'SELECT updated_at FROM project WHERE id = ?').get('p1')?.['updated_at'])).toBe(100)
  close(db)
})

test('only central/system may propose; human and empty actors are rejected', () => {
  const db = freshDb()
  expectThrow(() => proposeGoal(db, { projectId: 'p1', draft, actor: human }), 'forbidden')
  expectThrow(() => proposeGoal(db, { projectId: 'p1', draft, actor: { id: '', kind: 'central' } }), 'forbidden')
  expect(getGoal(db, 'p1')).toBe(null)
  expect(count(db, 'event')).toBe(0)
  close(db)
})

test('proposal requires the optimistic current version and bumps it on replace', () => {
  const db = freshDb()
  proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: null })
  expectThrow(
    () => proposeGoal(db, { projectId: 'p1', draft, actor: central }),
    'stale_version'
  )
  const replaced = proposeGoal(db, {
    projectId: 'p1',
    draft: { ...draft, statement: 'Revised outcome' },
    actor: central,
    expectedVersion: 1,
  })
  expect(replaced.version).toBe(2)
  expect(replaced.status).toBe('proposed')
  expect(replaced.statement).toBe('Revised outcome')
  close(db)
})

test('failed validation or stale version writes nothing (goal and audit unchanged)', () => {
  const db = freshDb()
  proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: null })
  const before = JSON.stringify(getGoal(db, 'p1'))
  const events = count(db, 'event')
  expectThrow(
    () => proposeGoal(db, {
      projectId: 'p1',
      draft: { ...draft, successCriteria: [] },
      actor: central,
      expectedVersion: 1,
    }),
    'invalid_criteria'
  )
  expectThrow(
    () => proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: 9 }),
    'stale_version'
  )
  expect(JSON.stringify(getGoal(db, 'p1'))).toBe(before)
  expect(count(db, 'event')).toBe(events)
  close(db)
})

test('activate requires the current version and records the caller', () => {
  const db = freshDb()
  proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: null })
  expectThrow(() => activateGoal(db, { projectId: 'p1', expectedVersion: 2, actor: human }), 'stale_version')
  const active = activateGoal(db, { projectId: 'p1', expectedVersion: 1, actor: human, now: 200 })
  expect(active.status).toBe('active')
  expect(active.version).toBe(2)
  const event = q(db, "SELECT actor, kind, payload_json FROM event WHERE kind = 'goal.activated'").get() as Row
  expect(String(event['actor'])).toBe('alice')
  expect(String(event['payload_json'])).toContain('"reason":null')
  expectThrow(() => activateGoal(db, { projectId: 'p1', expectedVersion: 1, actor: human }), 'stale_version')
  close(db)
})

test('an active goal blocks a new proposal until it is abandoned', () => {
  const db = freshDb()
  proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: null })
  activateGoal(db, { projectId: 'p1', expectedVersion: 1, actor: human })
  expectThrow(
    () => proposeGoal(db, { projectId: 'p1', draft, actor: central, expectedVersion: 2 }),
    'goal_active'
  )
  expectThrow(
    () => abandonGoal(db, { projectId: 'p1', expectedVersion: 2, actor: human, reason: '   ' }),
    'invalid_goal'
  )
  const abandoned = abandonGoal(db, { projectId: 'p1', expectedVersion: 2, actor: human, reason: 'Scope changed' })
  expect(abandoned.status).toBe('abandoned')
  expect(abandoned.version).toBe(3)
  const event = q(db, "SELECT payload_json FROM event WHERE kind = 'goal.abandoned'").get() as Row
  expect(String(event['payload_json'])).toContain('Scope changed')
  close(db)
})

test('unknown project is a typed not-found and leaves no row', () => {
  const db = freshDb()
  expectThrow(() => getGoal(db, 'missing'), 'project_not_found')
  expectThrow(
    () => proposeGoal(db, { projectId: 'missing', draft, actor: central, expectedVersion: null }),
    'project_not_found'
  )
  expect(count(db, 'project')).toBe(1)
  close(db)
})
