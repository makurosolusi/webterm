// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// Only toBe/toContain matchers are available (see src/server/bun-test.d.ts).
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgerDb } from './migration'
import {
  DuplicateIdemKeyError,
  IllegalTransitionError,
  StaleFenceError,
  createLedger,
  type Ledger,
  type LedgerEvent,
  type Task,
} from './ledger'

interface Stmt {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | null
  run(...params: unknown[]): unknown
}

function q(db: Database, sql: string): Stmt {
  return db.query(sql) as unknown as Stmt
}
function raw(db: Database, sql: string, ...params: unknown[]): void {
  q(db, sql).run(...params)
}
function close(db: Database): void {
  ;(db as unknown as { close(): void }).close()
}
function count(db: Database, table: string): number {
  return Number(q(db, `SELECT count(*) AS c FROM ${table}`).get()?.['c'] ?? -1)
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
const root = mkdtempSync(join(scratch && existsSync(scratch) ? scratch : tmpdir(), 'ledger-repo-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const T0 = 1_700_000_000_000

interface Fixture {
  db: Database
  ledger: Ledger
  projectId: string
  clock: { at: number }
  advance(ms: number): number
}

function fixture(projectId = 'p1', workspaceId = 'w1'): Fixture {
  const db = openLedgerDb(':memory:')
  const clock = { at: T0 }
  const ledger = createLedger(db, { now: () => clock.at })
  ledger.project.createProject({
    id: projectId,
    workspaceId,
    name: 'proj',
    path: `/tmp/${projectId}`,
  })
  return { db, ledger, projectId, clock, advance: (ms) => (clock.at += ms) }
}

function kinds(events: LedgerEvent[]): string {
  return events.map((e) => e.kind).join(',')
}

function makeTask(fx: Fixture, id = 't1'): Task {
  return fx.ledger.task.createTask({ id, projectId: fx.projectId, spec: 'do the thing' })
}

function leaseOrThrow(fx: Fixture, id = 't1', ttlMs = 100_000, owner = 'w-1'): Task {
  const got = fx.ledger.task.leaseTask(id, { owner, ttlMs })
  if (!got) throw new Error(`lease failed for ${id}`)
  return got
}

function leased(fx: Fixture, id = 't1', ttlMs = 100_000): Task {
  makeTask(fx, id)
  return leaseOrThrow(fx, id, ttlMs)
}

test('project and agent round-trip, lock epoch updates, depth 3 rejected by DB', () => {
  const fx = fixture()
  const p = fx.ledger.project.getProject('p1')
  expect(p === null).toBe(false)
  expect(p?.workspaceId).toBe('w1')
  expect(p?.lockEpoch).toBe(0)

  fx.ledger.project.createProject({
    id: 'p2', workspaceId: 'w2', name: 'hot', path: '/tmp/p2', priority: 9, branchBase: 'main',
    budget: { limit_micros: 500 },
  })
  expect(fx.ledger.project.listProjects().map((x) => x.id).join(',')).toBe('p2,p1')
  expect(JSON.stringify(fx.ledger.project.getProject('p2')?.budget)).toBe('{"limit_micros":500}')

  const locked = fx.ledger.project.setLockEpoch('p1', 4)
  expect(locked.lockEpoch).toBe(4)
  expect(locked.updatedAt).toBe(T0)
  expectThrow(() => fx.ledger.project.setLockEpoch('nope', 1), 'project not found')

  const a = fx.ledger.agent.createAgent({
    id: 'a0', projectId: 'p1', name: 'boss', role: 'orchestrator', depth: 0,
    capabilities: { tools: ['git'] }, sessionRef: 'sess-1',
  })
  expect(a.role).toBe('orchestrator')
  expect(JSON.stringify(a.capabilities)).toBe('{"tools":["git"]}')
  expect(fx.ledger.agent.createAgent({ id: 'a1', projectId: 'p1', parentAgentId: 'a0', depth: 1 }).depth).toBe(1)
  expectThrow(() => fx.ledger.agent.createAgent({ projectId: 'p1', depth: 3 }), 'CHECK constraint failed')
  close(fx.db)
})

test('agent state update writes state and heartbeat', () => {
  const fx = fixture()
  fx.ledger.agent.createAgent({ id: 'a0', projectId: 'p1', depth: 0 })
  const running = fx.ledger.agent.setAgentState('a0', 'running', 4242)
  expect(running.state).toBe('running')
  expect(running.heartbeatAt).toBe(4242)

  fx.advance(50)
  expect(fx.ledger.agent.setAgentState('a0', 'idle').heartbeatAt).toBe(T0 + 50)
  expectThrow(() => fx.ledger.agent.setAgentState('missing', 'idle'), 'agent not found')
  close(fx.db)
})

test('full lifecycle pending -> leased -> claimed_done -> verified', () => {
  const fx = fixture()
  const created = fx.ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 'ship it', idemKey: 'k1' })
  expect(created.status).toBe('pending')
  expect(created.fence).toBe(0)
  expect(created.attempt).toBe(0)
  expect(created.maxAttempts).toBe(3)

  const task = leaseOrThrow(fx)
  expect(task.status).toBe('leased')
  expect(task.fence).toBe(1)
  expect(task.attempt).toBe(1)
  expect(task.leaseOwner).toBe('w-1')
  expect(task.leaseExpires).toBe(T0 + 100_000)

  const claimed = fx.ledger.task.claimDone('t1', 1, { tests: 'bun test', diff: 'abc' })
  expect(claimed.status).toBe('claimed_done')
  expect(JSON.stringify(claimed.evidence)).toBe('{"tests":"bun test","diff":"abc"}')
  expect(claimed.leaseOwner).toBe(null)

  const verified = fx.ledger.task.verifyTask('t1', 1, { by: 'orchestrator' })
  expect(verified.status).toBe('verified')
  expect(JSON.stringify(verified.evidence)).toBe('{"by":"orchestrator"}')

  const events = fx.ledger.event.listEvents({ taskId: 't1' })
  expect(kinds(events)).toBe('task.created,task.leased,task.claimed_done,task.verified')
  expect(events[1]?.ts).toBe(T0)
  expect(events.every((e) => e.projectId === 'p1')).toBe(true)
  expect(events[1]?.actor).toBe('system')
  close(fx.db)
})

test('stale fence is rejected after a re-lease', () => {
  const fx = fixture()
  leased(fx)
  fx.advance(200_000)
  expect(fx.ledger.task.releaseToSuspect('t1')?.status).toBe('suspect')

  const re = fx.ledger.task.leaseTask('t1', { owner: 'w-2', ttlMs: 100_000 })
  expect(re?.fence).toBe(2)
  expect(re?.attempt).toBe(2)
  expect(re?.leaseOwner).toBe('w-2')

  const stale = expectThrow(() => fx.ledger.task.claimDone('t1', 1, { ok: true }), 'stale fence')
  expect(stale instanceof StaleFenceError).toBe(true)
  expect((stale as StaleFenceError).taskId).toBe('t1')
  expect((stale as StaleFenceError).actual).toBe(2)

  const still = fx.ledger.task.getTask('t1')
  expect(still?.status).toBe('leased')
  expect(still?.fence).toBe(2)
  expect(fx.ledger.task.claimDone('t1', 2, { ok: true }).status).toBe('claimed_done')
  close(fx.db)
})

test('expired lease becomes suspect and renew requires a live owned lease', () => {
  const fx = fixture()
  leased(fx, 't1', 100)
  expect(fx.advance(50)).toBe(T0 + 50)
  expect(fx.ledger.task.releaseToSuspect('t1')).toBe(null)
  expect(fx.ledger.task.renewLease('t1', 'intruder', 100)).toBe(null)
  expect(fx.ledger.task.renewLease('t1', 'w-1', 100)?.leaseExpires).toBe(T0 + 150)

  expect(fx.advance(120)).toBe(T0 + 170)
  expect(fx.ledger.task.renewLease('t1', 'w-1', 100)).toBe(null)
  const suspect = fx.ledger.task.releaseToSuspect('t1')
  expect(suspect?.status).toBe('suspect')
  expect(suspect?.leaseOwner).toBe(null)
  expect(suspect?.leaseExpires).toBe(null)

  const re = fx.ledger.task.leaseTask('t1', { owner: 'w-3', ttlMs: 10 })
  expect(re?.fence).toBe(2)
  expect(fx.ledger.task.leaseTask('t1', { owner: 'w-4', ttlMs: 10 })).toBe(null)
  close(fx.db)
})

test('illegal transitions are rejected with IllegalTransitionError', () => {
  const fx = fixture()
  fx.ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 's' })
  expectThrow(() => fx.ledger.task.claimDone('t1', 0, {}), 'pending -> claimed_done')
  expectThrow(() => fx.ledger.task.reopenTask('t1'), 'pending -> reopened')
  expectThrow(() => fx.ledger.task.verifyTask('t1', 0, {}), 'pending -> verified')

  const task = leaseOrThrow(fx)
  const illegal = expectThrow(
    () => fx.ledger.task.verifyTask('t1', task.fence, {}),
    'leased -> verified'
  )
  expect(illegal instanceof IllegalTransitionError).toBe(true)
  expect(fx.ledger.task.getTask('t1')?.status).toBe('leased')

  const failed = fx.ledger.task.failTask('t1', 1, 'tests red')
  expect(failed.status).toBe('failed')
  expect(JSON.stringify(failed.evidence)).toBe('{"reason":"tests red"}')
  expectThrow(() => fx.ledger.task.claimDone('t1', 1, {}), 'failed -> claimed_done')

  const reopened = fx.ledger.task.reopenTask('t1')
  expect(reopened.status).toBe('reopened')
  expect(reopened.fence).toBe(2)
  expectThrow(() => fx.ledger.task.failTask('t1', 1, 'stale'), 'stale fence')
  close(fx.db)
})

test('duplicate idem_key raises a typed error and keeps one task', () => {
  const fx = fixture()
  const first = fx.ledger.task.createTask({ projectId: 'p1', spec: 'a', idemKey: 'same' })
  const error = expectThrow(
    () => fx.ledger.task.createTask({ projectId: 'p1', spec: 'b', idemKey: 'same' }),
    'duplicate task idem_key same'
  )
  expect(error instanceof DuplicateIdemKeyError).toBe(true)
  expect((error as DuplicateIdemKeyError).existingId).toBe(first.id)
  expect(count(fx.db, 'task')).toBe(1)
  expect(fx.ledger.task.listTasks('p1').length).toBe(1)
  close(fx.db)
})

test('task transition and event commit atomically', () => {
  const fx = fixture()
  const task = leased(fx)
  const circular: Record<string, unknown> = {}
  circular['self'] = circular

  expectThrow(() => fx.ledger.task.claimDone('t1', task.fence, { ok: 1 }, { payload: circular }), 'JSON-serializable')
  const after = fx.ledger.task.getTask('t1')
  expect(after?.status).toBe('leased')
  expect(after?.evidence).toBe(null)
  expect(kinds(fx.ledger.event.listEvents({ taskId: 't1' }))).toBe('task.created,task.leased')

  expectThrow(
    () => fx.ledger.tx(() => {
      fx.ledger.task.failTask('t1', task.fence, 'boom')
      throw new Error('caller aborted')
    }),
    'caller aborted'
  )
  expect(fx.ledger.task.getTask('t1')?.status).toBe('leased')
  expect(kinds(fx.ledger.event.listEvents({ taskId: 't1' }))).toBe('task.created,task.leased')

  // The connection still works and is not stuck inside a transaction.
  expect(fx.ledger.tx(() => 7)).toBe(7)
  expect(fx.ledger.task.renewLease('t1', 'w-1', 1000)?.status).toBe('leased')
  close(fx.db)
})

test('listEvents paginates by ascending seq with filters and clamping', () => {
  const fx = fixture()
  fx.ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'other', path: '/tmp/p2' })
  for (let i = 0; i < 12; i++) {
    fx.ledger.event.appendEvent({
      projectId: i % 2 === 0 ? 'p1' : 'p2',
      actor: 'test',
      kind: `k${i}`,
      payload: { i },
      correlationId: 'c1',
    })
  }
  const all = fx.ledger.event.listEvents()
  expect(all.length).toBe(12)
  expect(all[0]?.kind).toBe('k0')
  expect(all[11]?.kind).toBe('k11')
  expect(all[0]!.seq < all[11]!.seq).toBe(true)

  const page = fx.ledger.event.listEvents({ limit: 5 })
  expect(page.length).toBe(5)
  expect(kinds(page)).toBe('k0,k1,k2,k3,k4')

  const next = fx.ledger.event.listEvents({ limit: 5, afterSeq: page[4]!.seq })
  expect(kinds(next)).toBe('k5,k6,k7,k8,k9')

  const onlyP1 = fx.ledger.event.listEvents({ projectId: 'p1' })
  expect(onlyP1.length).toBe(6)
  expect(onlyP1.every((e) => e.projectId === 'p1')).toBe(true)
  expect(fx.ledger.event.listEvents({ limit: 10_000 }).length).toBe(12)
  expectThrow(() => fx.ledger.event.listEvents({ limit: 0 }), 'limit must be a positive number')
  expect(fx.ledger.event.listEvents({ afterSeq: all[11]!.seq }).length).toBe(0)
  close(fx.db)
})

test('deleteProject cascades ledger rows and keeps memory with NULL project_id', () => {
  const fx = fixture()
  fx.ledger.agent.createAgent({ id: 'a0', projectId: 'p1', depth: 0 })
  fx.ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 's' })
  fx.ledger.event.appendEvent({ projectId: 'p1', taskId: 't1', actor: 'test', kind: 'project.event' })
  fx.ledger.event.appendEvent({ taskId: 't1', actor: 'test', kind: 'global.event' })

  raw(fx.db, 'INSERT INTO run (id, project_id, task_id, started_at) VALUES (?,?,?,?)', 'r1', 'p1', 't1', T0)
  raw(fx.db, 'INSERT INTO usage (id, run_id, ts) VALUES (?,?,?)', 'u1', 'r1', T0)
  raw(fx.db, 'INSERT INTO budget (id, project_id, limit_micros, updated_at) VALUES (?,?,?,?)', 'b1', 'p1', 100, T0)
  raw(fx.db, 'INSERT INTO prefix (id, project_id, hash, text, created_at) VALUES (?,?,?,?,?)', 'x1', 'p1', 'h', 'txt', T0)
  raw(
    fx.db,
    'INSERT INTO memory (id, project_id, key, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    'm1', 'p1', 'm1', 'note', 'body', T0, T0
  )

  expect(fx.ledger.deleteProject('p1')).toBe(true)
  for (const table of ['project', 'agent', 'task', 'run', 'usage', 'budget', 'prefix']) {
    expect(`${table}=${count(fx.db, table)}`).toBe(`${table}=0`)
  }
  // The project-scoped event cascaded away; the task-scoped one survives with
  // task_id NULL because event.task_id is ON DELETE SET NULL and project_id was NULL.
  const survivor = fx.ledger.event.listEvents()
  expect(survivor.length).toBe(1)
  expect(survivor[0]?.kind).toBe('global.event')
  expect(survivor[0]?.taskId).toBe(null)
  const memory = q(fx.db, 'SELECT project_id FROM memory WHERE id = ?').get('m1')
  expect(count(fx.db, 'memory')).toBe(1)
  expect(memory?.['project_id']).toBe(null)

  expect(fx.ledger.deleteProject('p1')).toBe(false)
  close(fx.db)
})

test('listTasks filters by status and paginates oldest-first', () => {
  const fx = fixture()
  for (let i = 0; i < 3; i++) {
    fx.ledger.task.createTask({ id: `t${i}`, projectId: 'p1', spec: `spec ${i}` })
    fx.advance(10)
  }
  expect(fx.ledger.task.listTasks('p1').map((t) => t.id).join(',')).toBe('t0,t1,t2')
  expect(fx.ledger.task.listTasks('p1', 'pending').length).toBe(3)
  expect(fx.ledger.task.listTasks('p1', 'leased').length).toBe(0)
  fx.ledger.task.leaseTask('t1', { owner: 'w-1', ttlMs: 1000 })
  expect(fx.ledger.task.listTasks('p1', 'leased').map((t) => t.id).join(',')).toBe('t1')
  expect(fx.ledger.task.listTasks('p1', 'pending', { limit: 1, offset: 1 }).map((t) => t.id).join(',')).toBe('t2')
  expectThrow(() => fx.ledger.task.listTasks('p1', 'bogus' as never), 'unknown status')
  close(fx.db)
})

test('ledger works on a file-backed DB and reopens with data intact', () => {
  const path = join(root, 'file.sqlite')
  const db = openLedgerDb(path)
  const ledger = createLedger(db, { now: T0 })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'p', path: '/tmp/p' })
  ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 's' })
  close(db)

  const reopened = openLedgerDb(path)
  const again = createLedger(reopened, { now: T0 + 1 })
  expect(again.task.getTask('t1')?.status).toBe('pending')
  expect(again.now()).toBe(T0 + 1)
  close(reopened)
})

test('cancel and block revoke a live lease and are audited', () => {
  const fx = fixture()
  makeTask(fx, 't-cancel')
  fx.ledger.task.leaseTask('t-cancel', { owner: 'w', ttlMs: 60_000 })
  const cancelled = fx.ledger.task.cancelTask('t-cancel', 'user stopped it')
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.fence).toBe(2)
  expect(cancelled.leaseOwner).toBe(null)
  expect(kinds(fx.ledger.event.listEvents({ taskId: 't-cancel' }))).toContain('task.cancelled')

  makeTask(fx, 't-block')
  const blocked = fx.ledger.task.blockTask('t-block', 'waiting on approval')
  expect(blocked.status).toBe('blocked')
  expectThrow(() => fx.ledger.task.cancelTask('nope', 'x'), 'not found')
  fx.ledger.task.reopenTask('t-block', { actor: 'human' })
  expect(fx.ledger.task.getTask('t-block')?.status).toBe('reopened')
})

test('sweepExpiredLeases moves only expired leases to suspect', () => {
  const fx = fixture()
  makeTask(fx, 't-old')
  makeTask(fx, 't-live')
  fx.ledger.task.leaseTask('t-old', { owner: 'w1', ttlMs: 10_000 })
  fx.advance(5_000)
  fx.ledger.task.leaseTask('t-live', { owner: 'w2', ttlMs: 60_000 })
  fx.advance(5_000)

  expect(fx.ledger.task.sweepExpiredLeases().join(',')).toBe('t-old')
  expect(fx.ledger.task.getTask('t-old')?.status).toBe('suspect')
  expect(fx.ledger.task.getTask('t-live')?.status).toBe('leased')
  expect(fx.ledger.task.sweepExpiredLeases().join(',')).toBe('')
})
