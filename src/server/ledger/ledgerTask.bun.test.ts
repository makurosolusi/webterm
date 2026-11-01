// Bun-only (needs bun:sqlite). Runs under `bun test`; vitest skips *.bun.test.ts.
// State-machine correctness: attempt cap, lease ownership, idem scoping, pagination.
import { afterAll, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgerDb } from './migration'
import {
  DuplicateIdemKeyError,
  LedgerError,
  StaleLeaseError,
  createLedger,
  type Ledger,
  type Task,
} from './ledger'
import { getTaskByIdemKey } from './ledgerTaskCreate'

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
const root = mkdtempSync(join(scratch && existsSync(scratch) ? scratch : tmpdir(), 'ledger-task-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const T0 = 1_700_000_000_000

interface Fixture {
  db: Database
  ledger: Ledger
  clock: { at: number }
  advance(ms: number): number
}

function fixture(projectId = 'p1'): Fixture {
  const db = openLedgerDb(':memory:')
  const clock = { at: T0 }
  const ledger = createLedger(db, { now: () => clock.at })
  ledger.project.createProject({ id: projectId, workspaceId: 'w1', name: 'p', path: '/tmp/p' })
  return { db, ledger, clock, advance: (ms) => (clock.at += ms) }
}

function leased(fx: Fixture, id = 't1', ttlMs = 1000, owner = 'w-1', maxAttempts = 3): Task {
  fx.ledger.task.createTask({ id, projectId: 'p1', spec: 's', maxAttempts })
  const got = fx.ledger.task.leaseTask(id, { owner, ttlMs })
  if (!got) throw new Error(`lease failed for ${id}`)
  return got
}

test('maxAttempts caps re-leasing: lease, expire, suspect, lease again returns null', () => {
  const fx = fixture()
  const first = leased(fx, 't1', 100, 'w-1', 1)
  expect(first.attempt).toBe(1)
  expect(first.maxAttempts).toBe(1)

  fx.advance(500)
  expect(fx.ledger.task.releaseToSuspect('t1')?.status).toBe('suspect')

  expect(fx.ledger.task.leaseTask('t1', { owner: 'w-2', ttlMs: 100 })).toBe(null)
  const after = fx.ledger.task.getTask('t1')
  expect(after?.attempt).toBe(1)
  expect(after?.fence).toBe(1)
  expect(after?.status).toBe('suspect')
  expect(after?.leaseOwner).toBe(null)
  close(fx.db)
})

test('claimDone rejects a dead lease after expiry', () => {
  const fx = fixture()
  const task = leased(fx, 't1', 100)
  fx.advance(150)

  const error = expectThrow(
    () => fx.ledger.task.claimDone('t1', task.fence, { ok: 1 }, { owner: 'w-1' }),
    'no live lease for task t1: lease expired'
  )
  expect(error instanceof StaleLeaseError).toBe(true)
  const still = fx.ledger.task.getTask('t1')
  expect(still?.status).toBe('leased')
  expect(still?.evidence).toBe(null)
  close(fx.db)
})

test('claimDone rejects a foreign owner and accepts the real one', () => {
  const fx = fixture()
  const task = leased(fx, 't1', 1000, 'w-1')

  const error = expectThrow(
    () => fx.ledger.task.claimDone('t1', task.fence, { ok: 1 }, { owner: 'w-2' }),
    'held by w-1, not w-2'
  )
  expect(error instanceof StaleLeaseError).toBe(true)
  expect(fx.ledger.task.getTask('t1')?.status).toBe('leased')

  const claimed = fx.ledger.task.claimDone('t1', task.fence, { ok: 1 }, { owner: 'w-1' })
  expect(claimed.status).toBe('claimed_done')
  expect(JSON.stringify(claimed.evidence)).toBe('{"ok":1}')
  close(fx.db)
})

test('failTask from a leased row requires a live lease held by the caller', () => {
  const fx = fixture()
  const task = leased(fx, 't1', 100, 'w-1')
  fx.advance(150)
  expectThrow(
    () => fx.ledger.task.failTask('t1', task.fence, 'zombie', { owner: 'w-1' }),
    'lease expired'
  )
  expect(fx.ledger.task.getTask('t1')?.status).toBe('leased')

  fx.advance(-100) // back to a live lease (the clock is injected)
  expectThrow(
    () => fx.ledger.task.failTask('t1', task.fence, 'foreign', { owner: 'w-9' }),
    'held by w-1, not w-9'
  )
  expect(fx.ledger.task.failTask('t1', task.fence, 'owned', { owner: 'w-1' }).status).toBe('failed')
  close(fx.db)
})

test('idem_key is scoped per project and resolvable by lookup', () => {
  const fx = fixture()
  fx.ledger.project.createProject({ id: 'p2', workspaceId: 'w2', name: 'o', path: '/tmp/p2' })

  const first = fx.ledger.task.createTask({ id: 'a1', projectId: 'p1', spec: 's', idemKey: 'k' })
  const second = fx.ledger.task.createTask({ id: 'b1', projectId: 'p2', spec: 's', idemKey: 'k' })
  expect(first.id).toBe('a1')
  expect(second.id).toBe('b1')

  const ctx = { db: fx.db, now: () => fx.clock.at }
  expect(getTaskByIdemKey(ctx, 'p1', 'k')?.id).toBe('a1')
  expect(getTaskByIdemKey(ctx, 'p2', 'k')?.id).toBe('b1')
  expect(getTaskByIdemKey(ctx, 'p2', 'missing')).toBe(null)
  expect(getTaskByIdemKey(ctx, 'p1', '')).toBe(null)

  const error = expectThrow(
    () => fx.ledger.task.createTask({ projectId: 'p1', spec: 's', idemKey: 'k' }),
    'duplicate task idem_key k'
  )
  expect(error instanceof DuplicateIdemKeyError).toBe(true)
  expect((error as DuplicateIdemKeyError).existingId).toBe('a1')
  expect(fx.ledger.task.listTasks('p1').length).toBe(1)
  close(fx.db)
})

test('empty idem_key is treated as absent', () => {
  const fx = fixture()
  const a = fx.ledger.task.createTask({ id: 'a1', projectId: 'p1', spec: 's', idemKey: '' })
  const b = fx.ledger.task.createTask({ id: 'b1', projectId: 'p1', spec: 's', idemKey: '   ' })
  expect(a.idemKey).toBe(null)
  expect(b.idemKey).toBe(null)
  expect(fx.ledger.task.listTasks('p1').length).toBe(2)
  close(fx.db)
})

test('listTasks rejects non-numeric limit/offset with a typed LedgerError', () => {
  const fx = fixture()
  fx.ledger.task.createTask({ id: 't1', projectId: 'p1', spec: 's' })

  const badLimit = expectThrow(
    () => fx.ledger.task.listTasks('p1', undefined, { limit: Number.NaN }),
    'listTasks: limit must be a positive number'
  )
  expect(badLimit instanceof LedgerError).toBe(true)
  expectThrow(
    () => fx.ledger.task.listTasks('p1', undefined, { limit: 'abc' as never }),
    'limit must be a positive number'
  )
  expectThrow(
    () => fx.ledger.task.listTasks('p1', undefined, { limit: 0 }),
    'limit must be a positive number'
  )
  expectThrow(
    () => fx.ledger.task.listTasks('p1', undefined, { offset: Number.NaN }),
    'offset must be a finite number'
  )
  // Valid input still clamps instead of leaking raw SQLite errors.
  expect(fx.ledger.task.listTasks('p1', undefined, { limit: 10_000 }).length).toBe(1)
  expect(fx.ledger.task.listTasks('p1', undefined, { offset: -5 }).length).toBe(1)
  close(fx.db)
})

test('renewLease rejects a caller-supplied past now instead of writing an expired lease', () => {
  const fx = fixture()
  leased(fx, 't1', 1000, 'w-1')
  expectThrow(
    () => fx.ledger.task.renewLease('t1', 'w-1', 5, T0 - 1),
    'before the lease start'
  )
  const still = fx.ledger.task.getTask('t1')
  expect(still?.leaseExpires).toBe(T0 + 1000)
  expect(fx.ledger.task.renewLease('t1', 'w-1', 500)?.leaseExpires).toBe(T0 + 500)
  close(fx.db)
})

test('COALESCE keeps prior evidence when null is passed to verify/fail', () => {
  const fx = fixture()
  const task = leased(fx, 't1', 1000, 'w-1')
  fx.ledger.task.claimDone('t1', task.fence, { claim: true }, { owner: 'w-1' })

  const verified = fx.ledger.task.verifyTask('t1', task.fence, null, { owner: 'w-1' })
  expect(JSON.stringify(verified.evidence)).toBe('{"claim":true}')

  const other = leased(fx, 't2', 1000, 'w-1')
  fx.ledger.task.claimDone('t2', other.fence, { claim: true }, { owner: 'w-1' })
  const failed = fx.ledger.task.failTask('t2', other.fence, 'nope', { owner: 'w-1' })
  expect(JSON.stringify(failed.evidence)).toBe('{"claim":true}')
  close(fx.db)
})
