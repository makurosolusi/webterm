import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { WorkStatus } from '../../../shared/centralWork'
import { migrate } from '../../ledger/migration'
import { beginDelegation, settleSend, type Delegation, type DelegationInput } from './workDelegation'
import type { WorkActor } from './workModel'
import { createWorkStore } from './workStore'

const CENTRAL: WorkActor = { kind: 'central' }

function setup() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0), ('q', 'x', 'q', '/tmp/q', 0, 0)`)
  let t = 1_800_000_000_000 // test-only fixed clock
  const store = createWorkStore(db, () => t++)
  const task = (id: string, projectId = 'p') => store.createTask({ id, projectId, title: `t ${id}`, objective: 'o', actor: CENTRAL })
  const force = (id: string, s: WorkStatus) => db.query('UPDATE central_task SET status = ? WHERE id = ?').run(s, id)
  const begin = (over: Partial<DelegationInput> = {}) => beginDelegation(store, { projectId: 'p', nodeId: 'n1', channel: 'chat', instruction: 'do the thing', conversationId: 'c1', turnId: 'turn1', ...over })
  const started = (over: Partial<DelegationInput> = {}): Delegation => {
    const d = begin(over)
    if (!d.ok) throw new Error(`begin refused: ${d.code}`)
    return d
  }
  return { store, task, force, begin, started }
}

test('without a task: creates a card from the instruction and opens an assignment', () => {
  const { store, started } = setup()
  const long = `line one\nline   two ${'x'.repeat(100)}`
  const d = started({ instruction: long })
  const task = store.getTask(d.taskId)
  expect(task).toMatchObject({ status: 'assigned', objective: long, acceptance: 'review', createdBy: 'central', conversationId: 'c1', turnId: 'turn1' })
  expect(task?.title).toBe(long.replace(/\s+/g, ' ').slice(0, 80))
  expect(store.getAssignment(d.assignmentId)).toMatchObject({ nodeId: 'n1', channel: 'chat', turnId: 'turn1', endedAt: null })
})

test('without a task: an open assignment makes it a follow-up on that card', () => {
  const { store, started } = setup()
  const first = started()
  const second = started({ instruction: 'and another' })
  expect(second).toMatchObject({ taskId: first.taskId, assignmentId: first.assignmentId })
  expect(store.listTasks({ projectId: 'p' })).toHaveLength(1)
  second.settleFailed('nope')
  expect(store.getAssignment(first.assignmentId)?.endedAt).toBeNull()
  expect(store.getTask(first.taskId)?.status).toBe('assigned')
})

test('another project\'s card under the same node id is not a follow-up', () => {
  const { started } = setup()
  const other = started({ projectId: 'q' })
  expect(started().taskId).not.toBe(other.taskId)
})

test('a blank instruction is refused', () => {
  expect(setup().begin({ instruction: '  \n' })).toMatchObject({ ok: false, code: 'invalid_shape' })
})

test('with a task: unknown or another project\'s task is not found', () => {
  const { task, begin } = setup()
  task('foreign', 'q')
  expect(begin({ taskId: 'missing' })).toMatchObject({ ok: false, code: 'task_not_found' })
  expect(begin({ taskId: 'foreign' })).toMatchObject({ ok: false, code: 'task_not_found' })
})

test('with a task: opens when the node is free', () => {
  const { store, task, started } = setup()
  task('a')
  const d = started({ taskId: 'a', agentId: 'ag1' })
  expect(d.taskId).toBe('a')
  expect(store.getTask('a')?.status).toBe('assigned')
  expect(store.getAssignment(d.assignmentId)?.agentId).toBe('ag1')
})

test('with a task: the same task already open is a follow-up', () => {
  const { store, task, started } = setup()
  task('a')
  const first = started({ taskId: 'a' })
  expect(started({ taskId: 'a' }).assignmentId).toBe(first.assignmentId)
  expect(store.assignmentsOfTask('a')).toHaveLength(1)
})

for (const status of ['assigned', 'running', 'waiting_input', 'stalled'] as const) {
  test(`with a task: a node busy on another task in ${status} is refused`, () => {
    const { store, task, force, started, begin } = setup()
    task('a'); task('b')
    const held = started({ taskId: 'a' })
    force('a', status)
    expect(begin({ taskId: 'b' })).toMatchObject({ ok: false, code: 'node_busy', data: { nodeId: 'n1', taskId: 'a' } })
    expect(store.getAssignment(held.assignmentId)?.endedAt).toBeNull()
    expect(store.getTask('b')?.status).toBe('todo')
  })
}

for (const status of ['reported', 'verifying', 'needs_review'] as const) {
  test(`with a task: a node whose task is ${status} is handed off`, () => {
    const { store, task, force, started } = setup()
    task('a'); task('b')
    const held = started({ taskId: 'a' })
    force('a', status)
    const next = started({ taskId: 'b' })
    expect(store.getAssignment(held.assignmentId)).toMatchObject({ endReason: 'handed_off' })
    expect(store.getTask('a')?.status).toBe(status)
    expect(store.openAssignmentOfNode('n1')?.id).toBe(next.assignmentId)
  })
}

test('with a task: a refused open leaves the previous card as it was', () => {
  const { store, task, force, started, begin } = setup()
  task('a'); task('done')
  const held = started({ taskId: 'a' })
  force('a', 'needs_review')
  force('done', 'done')
  expect(begin({ taskId: 'done' })).toMatchObject({ ok: false, code: 'illegal_transition' })
  expect(store.getAssignment(held.assignmentId)?.endedAt).toBeNull()
})

test('with a task: a failed task moves to todo, then opens', () => {
  const { store, task, force, started } = setup()
  task('a')
  force('a', 'failed')
  started({ taskId: 'a' })
  expect(store.timeline('a').map((e) => e.to).filter(Boolean)).toEqual(['todo', 'todo', 'assigned'])
  expect(store.getTask('a')?.status).toBe('assigned')
})

test('with a task: store refusals map to their codes', () => {
  const { task, force, started, begin } = setup()
  task('blocked'); force('blocked', 'blocked')
  expect(begin({ taskId: 'blocked' })).toMatchObject({ ok: false, code: 'task_blocked' })
  task('a')
  started({ taskId: 'a', nodeId: 'elsewhere' })
  expect(begin({ taskId: 'a', nodeId: 'n2' })).toMatchObject({ ok: false, code: 'assignment_open' })
})

test('unexpected errors propagate', () => {
  const { store } = setup()
  store.getTask = () => { throw new Error('disk full') }
  let message = ''
  try { beginDelegation(store, { projectId: 'p', nodeId: 'n', channel: 'chat', instruction: 'x', taskId: 'a', conversationId: 'c' }) } catch (err) { message = (err as Error).message }
  expect(message).toBe('disk full')
})

test('settleFailed: a task this call created ends failed', () => {
  const { store, started } = setup()
  const d = started()
  d.settleFailed('offline')
  expect(store.getAssignment(d.assignmentId)).toMatchObject({ endReason: 'send_failed', result: { reason: 'offline' } })
  expect(store.getTask(d.taskId)?.status).toBe('failed')
})

test('settleFailed: an existing task goes back where it was', () => {
  const { store, task, force, started } = setup()
  task('a')
  started({ taskId: 'a' }).settleFailed('offline')
  expect(store.getTask('a')?.status).toBe('todo')
  task('b')
  force('b', 'failed')
  started({ taskId: 'b', nodeId: 'n2' }).settleFailed('offline')
  expect(store.getTask('b')?.status).toBe('failed')
})

test('settleFailed: leaves a card the watcher has since moved, and tolerates an ended assignment', () => {
  const { store, task, force, started } = setup()
  task('a')
  const d = started({ taskId: 'a' })
  force('a', 'reported')
  store.endAssignment(d.assignmentId, 'finished')
  d.settleFailed('late')
  expect(store.getAssignment(d.assignmentId)?.endReason).toBe('finished')
  expect(store.getTask('a')?.status).toBe('reported')
})

test('settleSend reports a code, and rethrows with the assignment named', async () => {
  const { store, started } = setup()
  const refused = started()
  expect(await settleSend(refused, async () => 'no', () => 'denied')).toBe('no')
  expect(store.getTask(refused.taskId)?.status).toBe('failed')
  const thrown = started({ nodeId: 'n2' })
  const message = await settleSend(thrown, async () => { throw new Error('socket') }, () => null).catch((err: Error) => err.message)
  expect(message).toContain(thrown.assignmentId)
  expect(store.getAssignment(thrown.assignmentId)?.endReason).toBe('send_failed')
})
