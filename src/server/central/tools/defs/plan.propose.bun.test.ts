// plan.propose lands on the board (Goal -> Plan -> Task); goal.get reads the chain back.
import { beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate } from '../../../ledger/migration'
import { abandonGoal, activateGoal, proposeGoal } from '../../goalStore'
import { createWorkStore } from '../../work/workStore'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import { CORE_DEFS } from './core.defs'

const draft = { statement: 'Ship login', successCriteria: [{ kind: 'review', by: 'human' }], owner: 'human:a', horizon: '2030-01-02', envelope: { maxCostMicros: 1, maxWallMs: 1, maxItems: 1 } } // test-only
const central = { id: 'central', kind: 'central' }
const human = { id: 'human:root', kind: 'human' }

let db: Database
let ctx: Parameters<typeof execTool>[0]
beforeEach(() => {
  db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'One', '/tmp/p', 0, 0)`)
  const registry = createRegistry()
  for (const def of CORE_DEFS) registry.register(def)
  ctx = { db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R3', conversationId: 'central:global', now: () => 7 }
})

const plan = async (items: unknown[]): Promise<string[]> => {
  const res = await execTool(ctx, 'plan.propose', { projectId: 'p', items })
  expect(res.ok).toBe(true)
  return res.data?.taskIds as string[]
}
const tasks = () => db.query('SELECT id, title, objective, status, boundaries_json AS b, acceptance, due_at AS d, goal_version AS g, seq FROM central_task ORDER BY seq').all() as Array<Record<string, unknown>>
const count = (table: string): number => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const get = () => execTool(ctx, 'goal.get', { projectId: 'p' })

test('creates board tasks in order, with their fields, and no plan rows', async () => {
  const ids = await plan([{ title: 'a', objective: 'do a', scope: ['src/a'], acceptance: 'project_checks', dueAt: 9 }, { title: 'b' }])
  expect(tasks()).toMatchObject([
    { id: ids[0], title: 'a', objective: 'do a', status: 'todo', b: '["src/a"]', acceptance: 'project_checks', d: 9, g: null, seq: 1 },
    { id: ids[1], title: 'b', objective: 'b', status: 'todo', acceptance: 'review', g: null, seq: 2 },
  ])
  expect([count('plan'), count('plan_item')]).toEqual([0, 0])
})

test('blockedBy indexes become dependencies', async () => {
  const [a, b, c] = await plan([{ title: 'a' }, { title: 'b', blockedBy: [0] }, { title: 'c', blockedBy: [0, 1] }])
  const store = createWorkStore(db, () => 7)
  expect(store.getTask(b as string)).toMatchObject({ status: 'blocked', blockedBy: [a] })
  expect(store.getTask(c as string)?.blockedBy).toEqual([a, b].sort() as string[])
})

test('links to a proposed or active goal, and not to a closed one', async () => {
  proposeGoal(db, { projectId: 'p', draft, actor: central })
  await plan([{ title: 'under proposal' }])
  expect(tasks()[0]?.g).toBe(1)
  activateGoal(db, { projectId: 'p', expectedVersion: 1, actor: human })
  await plan([{ title: 'under active' }])
  expect(tasks().map((t) => t.g)).toEqual([2, 2])
  abandonGoal(db, { projectId: 'p', expectedVersion: 2, actor: human, reason: 'dropped' })
  await plan([{ title: 'after abandon' }])
  expect(tasks().map((t) => t.g)).toEqual([3, 3, null])
})

test('re-proposing a proposal keeps its tasks; a goal after a closed one starts empty', async () => {
  proposeGoal(db, { projectId: 'p', draft, actor: central })
  await plan([{ title: 'kept' }])
  proposeGoal(db, { projectId: 'p', draft: { ...draft, statement: 'Ship login v2' }, actor: central, expectedVersion: 1 })
  expect(tasks()[0]?.g).toBe(2)
  expect((await get()).data).toMatchObject({ total: 1 })
  activateGoal(db, { projectId: 'p', expectedVersion: 2, actor: human })
  abandonGoal(db, { projectId: 'p', expectedVersion: 3, actor: human, reason: 'dropped' })
  proposeGoal(db, { projectId: 'p', draft, actor: central, expectedVersion: 4 })
  expect((await get()).data).toMatchObject({ total: 0, goal: { version: 5 } })
})

test('a second call adds to the board and continues the order', async () => {
  const [first] = await plan([{ title: 'a' }])
  createWorkStore(db, () => 7).openAssignment({ taskId: first as string, nodeId: 'n', channel: 'terminal', instruction: 'go', actor: { kind: 'central' } })
  await plan([{ title: 'b' }])
  expect(tasks().map((t) => [t.title, t.seq, t.status])).toEqual([['a', 1, 'assigned'], ['b', 2, 'todo']])
})

test('one transaction: a failure on a later item leaves nothing behind', async () => {
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON central_task WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  const res = await execTool(ctx, 'plan.propose', { projectId: 'p', items: [{ title: 'fine' }, { title: 'boom' }] })
  expect(res.ok).toBe(false)
  expect(count('central_task')).toBe(0)
  expect((db.query(`SELECT COUNT(*) AS n FROM event WHERE kind LIKE 'work.%'`).get() as { n: number }).n).toBe(0)
})

test('refuses bad shapes before writing anything', async () => {
  for (const items of [[], [{}], [{ title: ' ' }], [{ title: 'a', blockedBy: [0] }], [{ title: 'a', blockedBy: [1] }, { title: 'b' }], [{ title: 'a', blockedBy: [-1] }], [{ title: 'a', scope: 'src' }], [{ title: 'a', acceptance: 'none' }], [{ title: 'a', extra: 1 }], Array.from({ length: 51 }, (_, i) => ({ title: `t${i}` }))]) {
    expect((await execTool(ctx, 'plan.propose', { projectId: 'p', items })).code).toBe('invalid_shape')
  }
  expect((await execTool(ctx, 'plan.propose', { projectId: 'p', items: [{ title: 'a' }], expectedVersion: 1 })).code).toBe('invalid_shape')
  expect(count('central_task')).toBe(0)
})

test('goal.get: no goal, then counts by column and completion, never achieved by itself', async () => {
  expect((await get()).data).toEqual({ goal: null, counts: { todo: 0, in_progress: 0, needs_review: 0, done: 0 }, total: 0, complete: false })
  proposeGoal(db, { projectId: 'p', draft, actor: central })
  const [a, b, c] = await plan([{ title: 'a' }, { title: 'b' }, { title: 'c' }])
  const set = (id: unknown, status: string) => db.query('UPDATE central_task SET status = ? WHERE id = ?').run(status, id as string)
  set(b, 'running')
  set(c, 'needs_review')
  expect((await get()).data).toMatchObject({ goal: { statement: 'Ship login', status: 'proposed' }, counts: { todo: 1, in_progress: 1, needs_review: 1, done: 0 }, total: 3, complete: false })
  set(a, 'done'); set(b, 'done'); set(c, 'cancelled')
  expect((await get()).data).toMatchObject({ goal: { status: 'proposed' }, counts: { done: 3 }, complete: true })
})

test('goal.get needs no tier above R0 and only takes projectId', async () => {
  expect((await execTool({ ...ctx, maxTier: 'R0' }, 'goal.get', { projectId: 'p' })).ok).toBe(true)
  expect((await execTool(ctx, 'goal.get', { projectId: 'p', extra: 1 })).code).toBe('invalid_shape')
})

test('every cancelled task is not a completed goal', async () => {
  proposeGoal(db, { projectId: 'p', draft, actor: central })
  const [a] = await plan([{ title: 'a' }])
  db.query(`UPDATE central_task SET status = 'cancelled' WHERE id = ?`).run(a as string)
  expect((await get()).data).toMatchObject({ total: 1, complete: false })
})
