import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { WORK_STATUSES, WORK_TRANSITIONS, boardColumnOf, type WorkStatus } from '../../../shared/centralWork'
import { migrate } from '../../ledger/migration'
import { WorkError, type WorkActor } from './workModel'
import { createWorkStore } from './workStore'

const T0 = 1_800_000_000_000 // test-only fixed clock
const HUMAN: WorkActor = { kind: 'human' }
const CENTRAL: WorkActor = { kind: 'central' }

const SPEC_EDGES: Record<WorkStatus, WorkStatus[]> = {
  todo: ['assigned', 'blocked', 'cancelled'],
  blocked: ['todo', 'cancelled'],
  assigned: ['running', 'stalled', 'failed', 'cancelled', 'todo'],
  running: ['waiting_input', 'stalled', 'reported', 'failed', 'cancelled'],
  waiting_input: ['running', 'reported', 'failed', 'cancelled'],
  stalled: ['running', 'waiting_input', 'reported', 'assigned', 'failed', 'cancelled'],
  reported: ['verifying', 'needs_review', 'running', 'cancelled'],
  verifying: ['needs_review', 'running', 'failed', 'cancelled'],
  needs_review: ['done', 'todo', 'running', 'cancelled'],
  failed: ['todo', 'cancelled'],
  done: ['todo'],
  cancelled: [],
}

function setup() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p', 'w', 'p', '/tmp/p', 0, 0)`)
  const clock = { t: T0, hook: null as null | (() => void) }
  const store = createWorkStore(db, () => { const h = clock.hook; clock.hook = null; h?.(); return clock.t++ })
  const task = (id: string) => store.createTask({ id, projectId: 'p', title: `t ${id}`, objective: 'o', actor: CENTRAL })
  const force = (id: string, s: WorkStatus) => db.query('UPDATE central_task SET status = ? WHERE id = ?').run(s, id)
  const events = (id: string) => db.query('SELECT kind, actor, payload_json FROM event WHERE correlation_id = ? ORDER BY seq').all(id) as { kind: string; actor: string; payload_json: string }[]
  const assign = (taskId: string, nodeId = 'n1') => store.openAssignment({ taskId, nodeId, channel: 'chat', instruction: 'do it', actor: CENTRAL })
  return { db, clock, store, task, force, events, assign }
}

function codeOf(fn: () => unknown): string {
  try { fn() } catch (err) {
    if (err instanceof WorkError) return err.code
    throw err
  }
  return 'no_error'
}

function messageOf(fn: () => unknown): string {
  try { fn() } catch (err) { return err instanceof Error ? err.message : String(err) }
  return 'no_error'
}

test('WORK_TRANSITIONS is the agreed edge table', () => {
  expect(WORK_TRANSITIONS as unknown).toEqual(SPEC_EDGES)
})

for (const from of WORK_STATUSES) {
  test(`every move out of ${from} is legal or refused as agreed`, () => {
    for (const to of WORK_STATUSES) {
      const { store, task, force, events } = setup()
      task('x')
      force('x', from)
      const before = events('x').length
      // done -> todo is an edge only for a task the system closed (auto-done); a forced done row was not.
      if (SPEC_EDGES[from].includes(to) && from !== 'done') {
        expect(store.moveTask('x', to, { actor: HUMAN }).status).toBe(to)
        expect(events('x').length).toBe(before + 1)
        expect(events('x').at(-1)?.kind).toBe(`work.task.${to}`)
        expect(JSON.parse(events('x').at(-1)?.payload_json ?? '{}')).toMatchObject({ from, to })
      } else {
        expect({ to, code: codeOf(() => store.moveTask('x', to, { actor: HUMAN })) }).toEqual({ to, code: 'illegal_transition' })
        expect(store.getTask('x')?.status).toBe(from)
        expect(events('x').length).toBe(before)
      }
    }
  })
}

test('every status has a board column', () => {
  expect(boardColumnOf('blocked')).toBe('todo')
  expect(boardColumnOf('waiting_input')).toBe('in_progress')
  expect(boardColumnOf('failed')).toBe('needs_review')
  expect(boardColumnOf('cancelled')).toBe('done')
  for (const s of WORK_STATUSES) expect(['todo', 'in_progress', 'needs_review', 'done']).toContain(boardColumnOf(s))
})

test('a write landing between read and update loses the CAS and rolls everything back', () => {
  const { db, clock, store, task, force, events } = setup()
  task('x')
  force('x', 'running')
  const before = events('x').length
  clock.hook = () => db.exec(`UPDATE central_task SET status = 'failed' WHERE id = 'x'`)
  expect(codeOf(() => store.moveTask('x', 'stalled', { actor: CENTRAL }))).toBe('concurrent_update')
  expect(store.getTask('x')?.status).toBe('running')
  expect(events('x').length).toBe(before)
})

test('done is refused for central and agents, even with autoDone', () => {
  const { store, task, force, events } = setup()
  task('x')
  force('x', 'needs_review')
  const before = events('x').length
  const fake = { kind: 'central', autoDone: true } as unknown as WorkActor
  for (const actor of [CENTRAL, fake, { kind: 'agent', id: 'a1' } as WorkActor, { kind: 'system' } as WorkActor]) {
    expect(codeOf(() => store.moveTask('x', 'done', { actor }))).toBe('done_forbidden')
  }
  expect(store.getTask('x')?.status).toBe('needs_review')
  expect(events('x').length).toBe(before)
})

test('done is allowed for a human and for system with autoDone', () => {
  const { store, task, force, events } = setup()
  task('a'); task('b')
  force('a', 'needs_review'); force('b', 'needs_review')
  expect(store.moveTask('a', 'done', { actor: HUMAN }).status).toBe('done')
  expect(events('a').at(-1)?.actor).toBe('human:ui')
  expect(store.moveTask('b', 'done', { actor: { kind: 'system', autoDone: true }, rule: 'acceptance.passed' }).status).toBe('done')
  expect(events('b').at(-1)?.actor).toBe('system:acceptance.passed')
})

test('moveTask on an unknown id is typed and names the id', () => {
  const { store } = setup()
  expect(messageOf(() => store.moveTask('ghost', 'todo', { actor: HUMAN }))).toBe('moveTask ghost: task_not_found')
})

test('setDeps refuses unknown ids, self deps and cycles, and leaves deps untouched', () => {
  const { store, task } = setup()
  task('a'); task('b'); task('c')
  expect(codeOf(() => store.setDeps('a', ['ghost']))).toBe('deps_unknown')
  expect(codeOf(() => store.setDeps('a', ['a']))).toBe('deps_cycle')
  store.setDeps('b', ['a'])
  store.setDeps('c', ['b'])
  expect(codeOf(() => store.setDeps('a', ['c']))).toBe('deps_cycle')
  expect(store.getTask('a')?.blockedBy).toEqual([])
  expect(store.getTask('c')?.blockedBy).toEqual(['b'])
})

test('a task with an unfinished dep is blocked; clearing the deps returns it to todo', () => {
  const { store, task, events } = setup()
  task('a'); task('b')
  expect(store.setDeps('b', ['a']).status).toBe('blocked')
  expect(events('b').at(-1)).toMatchObject({ kind: 'work.task.blocked', actor: 'system:deps' })
  expect(codeOf(() => store.moveTask('b', 'todo', { actor: HUMAN }))).toBe('blocked_by_deps')
  expect(store.setDeps('b', []).status).toBe('todo')
})

test('a dep that is already done does not block', () => {
  const { store, task, force } = setup()
  task('a'); task('b')
  force('a', 'done')
  expect(store.setDeps('b', ['a']).status).toBe('todo')
})

test('deps of a started task are locked', () => {
  const { store, task, force } = setup()
  task('a'); task('b')
  force('b', 'running')
  expect(codeOf(() => store.setDeps('b', ['a']))).toBe('deps_locked')
})

test('a blocked task cannot be assigned', () => {
  const { store, task, assign } = setup()
  task('a'); task('b')
  store.setDeps('b', ['a'])
  expect(codeOf(() => assign('b'))).toBe('task_blocked')
  expect(store.openAssignments()).toEqual([])
})

test('done unblocks dependents with nothing left unfinished, in the same move', () => {
  const { store, task, force, events } = setup()
  task('a'); task('b'); task('solo'); task('both')
  store.setDeps('solo', ['a'])
  store.setDeps('both', ['a', 'b'])
  force('a', 'needs_review')
  store.moveTask('a', 'done', { actor: HUMAN })
  expect(store.getTask('solo')?.status).toBe('todo')
  expect(store.getTask('both')?.status).toBe('blocked')
  expect(events('solo').at(-1)).toMatchObject({ kind: 'work.task.todo', actor: 'system:deps' })
  force('b', 'needs_review')
  store.moveTask('b', 'done', { actor: HUMAN })
  expect(store.getTask('both')?.status).toBe('todo')
})

test('a cancelled dep does not unblock', () => {
  const { store, task } = setup()
  task('a'); task('b')
  store.setDeps('b', ['a'])
  store.moveTask('a', 'cancelled', { actor: HUMAN })
  expect(store.getTask('b')?.status).toBe('blocked')
})

test('openAssignment moves the task, clips the instruction and records both events', () => {
  const { store, task, events } = setup()
  task('x')
  const a = store.openAssignment({ taskId: 'x', nodeId: 'n1', channel: 'terminal', instruction: 'z'.repeat(5000), actor: CENTRAL, agentId: 'ag1', conversationId: 'c1', turnId: 't1' })
  expect(a).toMatchObject({ taskId: 'x', projectId: 'p', nodeId: 'n1', agentId: 'ag1', channel: 'terminal', attempt: 1, restarts: 0, endedAt: null })
  expect(a.instruction.length).toBe(4000)
  expect(store.getTask('x')?.status).toBe('assigned')
  expect(store.openAssignmentOfNode('n1')?.id).toBe(a.id)
  const added = events('x').slice(1)
  expect(added.map((e) => e.kind)).toEqual(['work.assignment.open', 'work.task.assigned'])
  for (const e of added) {
    expect(e.payload_json).not.toContain('zzz')
    expect(JSON.parse(e.payload_json)).toMatchObject({ assignmentId: a.id, nodeId: 'n1', conversationId: 'c1', turnId: 't1' })
  }
})

test('a second open assignment is refused; attempt increments across attempts', () => {
  const { store, task, force, assign } = setup()
  task('x')
  const first = assign('x')
  force('x', 'todo')
  expect(codeOf(() => assign('x'))).toBe('assignment_open')
  store.endAssignment(first.id, 'gave up')
  expect(assign('x').attempt).toBe(2)
})

test('openAssignment needs a legal edge; a rollback leaves no assignment behind', () => {
  const { store, task, force, assign, events } = setup()
  task('x')
  force('x', 'running')
  const before = events('x').length
  expect(codeOf(() => assign('x'))).toBe('illegal_transition')
  expect(store.openAssignments()).toEqual([])
  expect(events('x').length).toBe(before)
})

test('a stalled task can be reassigned', () => {
  const { store, task, force, assign } = setup()
  task('x')
  force('x', 'stalled')
  assign('x')
  expect(store.getTask('x')?.status).toBe('assigned')
})

test('touchSignal writes no event; nudge and restart update the row; ended assignments refuse them', () => {
  const { store, task, assign, events } = setup()
  task('x')
  const a = assign('x')
  const before = events('x').length
  expect(store.touchSignal(a.id, 'hook:PostToolUse', 42)).toBe(true)
  expect(store.markNudged(a.id, 43)).toBe(true)
  expect(store.incrementRestarts(a.id)).toBe(true)
  expect(events('x').length).toBe(before)
  expect(store.getAssignment(a.id)).toMatchObject({ lastSignal: 'hook:PostToolUse', lastSignalAt: 42, nudgedAt: 43, restarts: 1 })
  store.endAssignment(a.id, 'done')
  expect(store.touchSignal(a.id, 'late', 44)).toBe(false)
  expect(store.markNudged(a.id, 44)).toBe(false)
  expect(store.incrementRestarts(a.id)).toBe(false)
  expect(store.getAssignment(a.id)?.lastSignal).toBe('hook:PostToolUse')
})

test('endAssignment stores the result, writes one event, and refuses a second end', () => {
  const { store, task, assign, events } = setup()
  task('x')
  const a = assign('x')
  const before = events('x').length
  const ended = store.endAssignment(a.id, 'reported', { summary: 'ok' })
  expect(ended).toMatchObject({ endReason: 'reported', result: { summary: 'ok' } })
  expect(typeof ended.endedAt).toBe('number')
  expect(events('x').length).toBe(before + 1)
  expect(events('x').at(-1)).toMatchObject({ kind: 'work.assignment.end', actor: 'system:assignment.end' })
  expect(store.openAssignmentOfNode('n1')).toBeNull()
  expect(codeOf(() => store.endAssignment(a.id, 'again'))).toBe('assignment_ended')
  expect(codeOf(() => store.endAssignment('ghost', 'x'))).toBe('assignment_not_found')
})

test('a move rejects an assignment of another task', () => {
  const { store, task, assign } = setup()
  task('x'); task('y')
  const a = assign('x')
  expect(codeOf(() => store.moveTask('y', 'assigned', { actor: CENTRAL, assignmentId: a.id }))).toBe('assignment_not_found')
  expect(store.getTask('y')?.status).toBe('todo')
})

test('the event carries the central task id as correlation, never the ledger task_id', () => {
  const { db, task } = setup()
  task('x')
  expect(db.query(`SELECT task_id, correlation_id, project_id, actor FROM event WHERE correlation_id = 'x'`).all()).toEqual([{ task_id: null, correlation_id: 'x', project_id: 'p', actor: 'central' }])
})

test('timeline is oldest first and paged', () => {
  const { store, task } = setup()
  task('x')
  for (const to of ['assigned', 'running', 'reported'] as const) store.moveTask('x', to, { actor: CENTRAL, reason: `to ${to}` })
  expect(store.timeline('x').map((e) => e.kind)).toEqual(['work.task.todo', 'work.task.assigned', 'work.task.running', 'work.task.reported'])
  expect(store.timeline('x', { limit: 2 }).map((e) => e.to)).toEqual(['todo', 'assigned'])
  expect(store.timeline('x', { limit: 2, offset: 2 }).map((e) => e.to)).toEqual(['running', 'reported'])
  expect(store.timeline('x').at(1)).toMatchObject({ taskId: 'x', from: 'todo', to: 'assigned', reason: 'to assigned', actor: 'central' })
  expect(store.timeline('other')).toEqual([])
})

test('updateTask changes only what the patch names and writes no event', () => {
  const { store, events } = setup()
  store.createTask({ id: 'x', projectId: 'p', title: 'a', objective: 'o', actor: CENTRAL, dueAt: 9, boundaries: ['src'] })
  const before = events('x').length
  expect(store.updateTask('x', { title: 'b', dueAt: null })).toMatchObject({ title: 'b', objective: 'o', dueAt: null, boundaries: ['src'], acceptance: 'review' })
  expect(store.updateTask('x', { acceptance: 'project_checks', boundaries: null })).toMatchObject({ title: 'b', acceptance: 'project_checks', boundaries: null })
  expect(events('x').length).toBe(before)
  expect(codeOf(() => store.updateTask('ghost', { title: 'b' }))).toBe('task_not_found')
})

test('createTask refuses an unknown project and a blank title', () => {
  const { store } = setup()
  expect(codeOf(() => store.createTask({ projectId: 'ghost', title: 't', objective: 'o', actor: CENTRAL }))).toBe('project_not_found')
  expect(messageOf(() => store.createTask({ projectId: 'p', title: ' ', objective: 'o', actor: CENTRAL }))).toContain('task.title')
})

test('listTasks filters by project and status, newest update first, paged', () => {
  const { db, store, task, force } = setup()
  db.exec(`INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('q', 'w2', 'q', '/tmp/q', 0, 0)`)
  task('a'); task('b'); task('c')
  store.createTask({ id: 'other', projectId: 'q', title: 't', objective: 'o', actor: CENTRAL })
  force('b', 'running')
  store.setDeps('c', ['a'])
  expect(store.listTasks({ projectId: 'p' }).map((t) => t.id)).toEqual(['c', 'b', 'a'])
  expect(store.listTasks({ statuses: ['running', 'blocked'] }).map((t) => t.id)).toEqual(['c', 'b'])
  expect(store.listTasks({ projectId: 'p', limit: 1, offset: 1 }).map((t) => t.id)).toEqual(['b'])
  expect(store.listTasks({ projectId: 'p' })[0]?.blockedBy).toEqual(['a'])
})
