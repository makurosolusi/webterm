// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Only toBe/toContain matchers are available (see src/server/bun-test.d.ts).
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LATEST_VERSION, openLedgerDb } from '../ledger/migration'
import { PlanError, StalePlanVersionError, createPlanStore, type PlanStore } from './plan'

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
function first(db: Database, sql: string, ...params: unknown[]): unknown {
  return q(db, sql).get(...params)?.['c']
}

const scratch = process.env.JCODE_SCRATCH_DIR
const root = mkdtempSync(join(scratch ?? '/tmp', 'plan-test-'))
mkdirSync(root, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dbSeq = 0
let idSeq = 0

function fixture(): { store: PlanStore; db: Database } {
  const db = openLedgerDb(join(root, `plan-${dbSeq++}.sqlite`))
  q(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p1','w1','p','/tmp/repo',1,1)").run()
  q(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p2','w2','p2','/tmp/repo2',1,1)").run()
  const store = createPlanStore(db, { now: () => 1000, newId: () => `id-${idSeq++}` })
  return { store, db }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code)
    return
  }
  throw new Error(`expected PlanError ${code}, nothing thrown`)
}

test('fresh db is at schema v2 with plan tables', () => {
  const { db } = fixture()
  expect(Number(q(db, 'PRAGMA user_version').get()?.['user_version'])).toBe(LATEST_VERSION)
  const names = q(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan%'")
    .all()
    .map((row) => String(row['name']))
    .join(',')
  expect(names).toContain('plan')
  expect(names).toContain('plan_item')
  close(db)
})

test('create stores version 1, pending items, and normalized scope in order', () => {
  const { store, db } = fixture()
  const plan = store.create({
    projectId: 'p1',
    items: [
      { title: 'api', scope: ['./src/api.ts', 'src/api.ts', 'src/shared/'] },
      { title: 'ui', scope: ['src/client/App.tsx'] },
    ],
  })
  expect(plan.version).toBe(1)
  expect(plan.status).toBe('draft')
  expect(plan.items.length).toBe(2)
  expect(plan.items[0]?.seq).toBe(0)
  expect(plan.items[0]?.status).toBe('pending')
  expect(plan.items[0]?.taskId).toBe(null)
  expect(JSON.stringify(plan.items[0]?.scope)).toBe('["src/api.ts","src/shared"]')
  expect(store.get('p1')?.items[1]?.title).toBe('ui')
  expectCode(
    () => store.create({ projectId: 'p1', items: [{ title: 'again', scope: ['a'] }] }),
    'plan_exists'
  )
  close(db)
})

test('invalid scope/title/items are rejected before any row is written', () => {
  const { store, db } = fixture()
  expectCode(() => store.create({ projectId: 'p1', items: [] }), 'invalid_item')
  expectCode(
    () => store.create({ projectId: 'p1', items: [{ title: 'x', scope: ['../etc/passwd'] }] }),
    'invalid_scope'
  )
  expectCode(
    () => store.create({ projectId: 'p1', items: [{ title: 'x', scope: ['/abs/path'] }] }),
    'invalid_scope'
  )
  expectCode(
    () => store.create({ projectId: 'p1', items: [{ title: '   ', scope: ['a'] }] }),
    'invalid_item'
  )
  expect(store.get('p1')).toBe(null)
  close(db)
})

test('assign links a task once, bumps the version, and refuses re-assign or unknown items', () => {
  const { store, db } = fixture()
  const plan = store.create({ projectId: 'p1', items: [{ title: 'a', scope: ['src/a.ts'] }] })
  const itemId = plan.items[0]?.id as string
  const assigned = store.assign({
    projectId: 'p1',
    itemId,
    taskId: 't1',
    assignee: 'w1',
    expectedVersion: 1,
  })
  expect(assigned.version).toBe(2)
  expect(assigned.items[0]?.status).toBe('assigned')
  expect(assigned.items[0]?.taskId).toBe('t1')
  expect(assigned.items[0]?.assignedAt).toBe(1000)

  // Assign is only legal before spawn: a second assign fails even with the fresh version.
  expectCode(
    () =>
      store.assign({ projectId: 'p1', itemId, taskId: 't2', assignee: 'w2', expectedVersion: 2 }),
    'task_already_assigned'
  )
  expectCode(
    () =>
      store.assign({
        projectId: 'p1',
        itemId: 'missing',
        taskId: 't3',
        assignee: 'w2',
        expectedVersion: 2,
      }),
    'item_not_found'
  )
  close(db)
})

test('stale version is rejected on assign, updateItem, and replace', () => {
  const { store, db } = fixture()
  const plan = store.create({
    projectId: 'p1',
    items: [
      { title: 'a', scope: ['src/a.ts'] },
      { title: 'b', scope: ['src/b.ts'] },
    ],
  })
  const itemId = plan.items[0]?.id as string
  // Move the plan to v2 so v1 becomes stale.
  store.assign({ projectId: 'p1', itemId, taskId: 't1', assignee: 'w1', expectedVersion: 1 })

  let err: unknown
  try {
    store.updateItem({ projectId: 'p1', itemId, expectedVersion: 1, actor: 'w1', status: 'running' })
  } catch (caught) {
    err = caught
  }
  expect(err instanceof StalePlanVersionError).toBe(true)
  expect((err as StalePlanVersionError).expected).toBe(1)
  expect((err as StalePlanVersionError).actual).toBe(2)

  expectCode(
    () =>
      store.assign({ projectId: 'p1', itemId: 'x', taskId: 't9', assignee: 'w1', expectedVersion: 1 }),
    'stale_version'
  )
  expectCode(
    () =>
      store.replace({
        projectId: 'p1',
        expectedVersion: 1,
        items: [{ title: 'c', scope: ['src/c.ts'] }],
      }),
    'stale_version'
  )
  close(db)
})

test('only the item assignee may update it, and only along legal transitions', () => {
  const { store, db } = fixture()
  const plan = store.create({ projectId: 'p1', items: [{ title: 'a', scope: ['src/a.ts'] }] })
  const itemId = plan.items[0]?.id as string
  const v = store.assign({ projectId: 'p1', itemId, taskId: 't1', assignee: 'w1', expectedVersion: 1 })

  expectCode(
    () =>
      store.updateItem({
        projectId: 'p1',
        itemId,
        expectedVersion: v.version,
        actor: 'w2',
        status: 'running',
      }),
    'not_participant'
  )
  const running = store.updateItem({
    projectId: 'p1',
    itemId,
    expectedVersion: v.version,
    actor: 'w1',
    status: 'running',
  })
  expect(running.items[0]?.status).toBe('running')
  expect(running.version).toBe(3)
  // Repeating running is not a legal transition; only running->done/failed/cancelled is.
  expectCode(
    () =>
      store.updateItem({
        projectId: 'p1',
        itemId,
        expectedVersion: running.version,
        actor: 'w1',
        status: 'running',
      }),
    'invalid_transition'
  )
  const done = store.updateItem({
    projectId: 'p1',
    itemId,
    expectedVersion: running.version,
    actor: 'w1',
    status: 'done',
  })
  expect(done.items[0]?.status).toBe('done')
  expect(done.version).toBe(4)
  close(db)
})

test('replace refuses a plan with assigned/running items and works when all are pending', () => {
  const { store, db } = fixture()
  const plan = store.create({ projectId: 'p1', items: [{ title: 'a', scope: ['src/a.ts'] }] })
  const itemId = plan.items[0]?.id as string
  const v = store.assign({ projectId: 'p1', itemId, taskId: 't1', assignee: 'w1', expectedVersion: 1 })
  expectCode(
    () =>
      store.replace({
        projectId: 'p1',
        expectedVersion: v.version,
        items: [{ title: 'b', scope: ['b'] }],
      }),
    'plan_in_progress'
  )

  const fresh = store.create({ projectId: 'p2', items: [{ title: 'a', scope: ['x'] }] })
  const replaced = store.replace({
    projectId: 'p2',
    expectedVersion: fresh.version,
    items: [{ title: 'b', scope: ['y'] }],
    status: 'active',
  })
  expect(replaced.version).toBe(2)
  expect(replaced.status).toBe('active')
  expect(replaced.items.length).toBe(1)
  expect(replaced.items[0]?.title).toBe('b')
  close(db)
})

test('deleting the project cascades plan and plan_item rows', () => {
  const { store, db } = fixture()
  store.create({ projectId: 'p1', items: [{ title: 'a', scope: ['src/a.ts'] }] })
  q(db, "DELETE FROM project WHERE id = 'p1'").run()
  expect(Number(first(db, 'SELECT count(*) AS c FROM plan'))).toBe(0)
  expect(Number(first(db, 'SELECT count(*) AS c FROM plan_item'))).toBe(0)
  expect(store.get('p1')).toBe(null)
  close(db)
})

test('PlanError carries a typed code for callers that must deny, not throw', () => {
  const { store, db } = fixture()
  try {
    store.assign({ projectId: 'nope', itemId: 'x', taskId: 't', assignee: 'w', expectedVersion: 1 })
  } catch (err) {
    expect(err instanceof PlanError).toBe(true)
    expect((err as PlanError).code).toBe('plan_not_found')
  }
  close(db)
})
