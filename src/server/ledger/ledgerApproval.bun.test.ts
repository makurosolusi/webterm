import { expect, test } from 'bun:test'
import { createLedger } from './ledger'
import { openLedgerDb } from './migration'
import { approvalDigest } from './ledgerApproval'

const T0 = 1_700_000_000_000

function fixture() {
  const db = openLedgerDb(':memory:')
  const clock = { at: T0 }
  const ledger = createLedger(db, { now: () => clock.at })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'p', path: '/tmp/p' })
  return { ledger, clock }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

test('digest is stable across key order and changes with the action', () => {
  expect(approvalDigest({ a: 1, b: [2, 3] })).toBe(approvalDigest({ b: [2, 3], a: 1 }))
  expect(approvalDigest({ a: 1 })).not.toBe(approvalDigest({ a: 2 }))
})

test('approve with nonce+digest, then consume exactly once', () => {
  const { ledger } = fixture()
  const action = { kind: 'git.push', branch: 'main', sha: 'abc' }
  const challenge = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'push',
    request: action,
    ttlMs: 60_000,
  })
  expect(challenge.digest).toBe(approvalDigest(action))
  expect(ledger.approval.getApproval(challenge.id)?.status).toBe('pending')

  expect(throws(() => ledger.approval.decideApproval(challenge.id, {
    actor: 'human',
    approve: true,
    digest: challenge.digest,
    nonce: 'wrong',
  }))).toBe(true)
  expect(throws(() => ledger.approval.decideApproval(challenge.id, {
    actor: 'human',
    approve: true,
    digest: approvalDigest({ sha: 'changed' }),
    nonce: challenge.nonce,
  }))).toBe(true)

  const approved = ledger.approval.decideApproval(challenge.id, {
    actor: 'human',
    approve: true,
    digest: challenge.digest,
    nonce: challenge.nonce,
  })
  expect(approved.status).toBe('approved')
  expect(approved.approvedBy).toBe('human')

  expect(ledger.approval.consumeApproval(challenge.id, { digest: challenge.digest })).toBe(true)
  expect(ledger.approval.consumeApproval(challenge.id, { digest: challenge.digest })).toBe(false)
})

test('reject, expiry, and list filters behave', () => {
  const { ledger, clock } = fixture()
  const rejected = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'migration',
    request: { sql: 'drop table x' },
  })
  expect(ledger.approval.decideApproval(rejected.id, {
    actor: 'human',
    approve: false,
    digest: rejected.digest,
    nonce: rejected.nonce,
  }).status).toBe('rejected')
  expect(ledger.approval.consumeApproval(rejected.id, { digest: rejected.digest })).toBe(false)

  const expiring = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'delete',
    request: { path: '/tmp' },
    ttlMs: 1000,
  })
  clock.at += 1500
  expect(throws(() => ledger.approval.decideApproval(expiring.id, {
    actor: 'human',
    approve: true,
    digest: expiring.digest,
    nonce: expiring.nonce,
  }))).toBe(true)
  expect(ledger.approval.getApproval(expiring.id)?.status).toBe('expired')

  const pending = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'push',
    request: {},
    ttlMs: 1000,
  })
  expect(ledger.approval.listApprovals({ projectId: 'p1', status: 'pending' }).length).toBe(1)
  expect(ledger.approval.expireApprovals(clock.at + 10 * 60_000) >= 1).toBe(true)
  expect(ledger.approval.getApproval(pending.id)?.status).toBe('expired')
})
