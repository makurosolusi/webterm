import { expect, test } from 'bun:test'
import { createLedger } from '../ledger/ledger'
import { approvalDigest } from '../ledger/ledgerApproval'
import { openLedgerDb } from '../ledger/migration'
import { ApprovalRequiredError, runApproved } from './approvalGate'

const T0 = 1_700_000_000_000
const ACTION = { kind: 'git.push', branch: 'main', sha: 'abc' }

function fixture() {
  const db = openLedgerDb(':memory:')
  const clock = { at: T0 }
  const ledger = createLedger(db, { now: () => clock.at })
  ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'p', path: '/tmp/p' })
  return { ledger, clock }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected rejection')
}

function rejectionCode(err: unknown): string {
  if (!(err instanceof ApprovalRequiredError)) {
    throw new Error(`expected ApprovalRequiredError, got ${String(err)}`)
  }
  return err.code
}

function approved(ledger: ReturnType<typeof createLedger>, ttlMs = 60_000) {
  const challenge = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'push',
    request: ACTION,
    ttlMs,
  })
  ledger.approval.decideApproval(challenge.id, {
    actor: 'human',
    approve: true,
    digest: challenge.digest,
    nonce: challenge.nonce,
  })
  return challenge
}

test('consumes a real ledger approval once, then refuses reuse', async () => {
  const { ledger } = fixture()
  const challenge = approved(ledger)
  const deps = { approval: ledger.approval }
  const request = { approvalId: challenge.id, digest: approvalDigest(ACTION), now: T0 + 1000 }
  let ran = 0

  await runApproved(deps, request, () => {
    ran += 1
  })
  expect(ran).toBe(1)

  const second = await failure(
    runApproved(deps, request, () => {
      ran += 1
    })
  )
  expect(rejectionCode(second)).toBe('approval_already_consumed')
  expect(ran).toBe(1)
})

test('action failure does not re-enable the approval', async () => {
  const { ledger } = fixture()
  const challenge = approved(ledger)
  const deps = { approval: ledger.approval }
  const request = { approvalId: challenge.id, digest: approvalDigest(ACTION), now: T0 + 1000 }
  let ran = 0

  const first = await failure(
    runApproved(deps, request, () => {
      ran += 1
      throw new Error('push failed')
    })
  )
  expect((first as Error).message).toBe('push failed')

  const second = await failure(
    runApproved(deps, request, () => {
      ran += 1
    })
  )
  expect(rejectionCode(second)).toBe('approval_already_consumed')
  expect(ran).toBe(1)
})

test('pending and rejected decisions never run the action', async () => {
  const { ledger } = fixture()
  const pending = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'push',
    request: ACTION,
    ttlMs: 60_000,
  })
  const rejected = ledger.approval.requestApproval({
    projectId: 'p1',
    kind: 'push',
    request: ACTION,
    ttlMs: 60_000,
  })
  ledger.approval.decideApproval(rejected.id, {
    actor: 'human',
    approve: false,
    digest: rejected.digest,
    nonce: rejected.nonce,
  })
  let ran = 0
  const deps = { approval: ledger.approval }

  expect(
    rejectionCode(
      await failure(
        runApproved(
          deps,
          { approvalId: pending.id, digest: approvalDigest(ACTION), now: T0 },
          () => {
            ran += 1
          }
        )
      )
    )
  ).toBe('approval_pending')
  expect(
    rejectionCode(
      await failure(
        runApproved(
          deps,
          { approvalId: rejected.id, digest: approvalDigest(ACTION), now: T0 },
          () => {
            ran += 1
          }
        )
      )
    )
  ).toBe('approval_rejected')
  expect(ran).toBe(0)
})

test('expiry and digest mismatch are rejected before consume', async () => {
  const { ledger, clock } = fixture()
  const expired = approved(ledger, 1000)

  clock.at = T0 + 2000
  const late = await failure(
    runApproved(
      { approval: ledger.approval },
      { approvalId: expired.id, digest: approvalDigest(ACTION), now: T0 + 2000 },
      () => 'nope'
    )
  )
  expect(rejectionCode(late)).toBe('approval_expired')

  clock.at = T0
  const fresh = approved(ledger)
  const wrong = await failure(
    runApproved(
      { approval: ledger.approval },
      {
        approvalId: fresh.id,
        digest: approvalDigest({ kind: 'git.push', branch: 'main', sha: 'other' }),
        now: T0,
      },
      () => 'nope'
    )
  )
  expect(rejectionCode(wrong)).toBe('approval_digest_mismatch')
  expect(ledger.approval.getApproval(fresh.id)?.status).toBe('approved')
})

test('unknown approval id is rejected', async () => {
  const { ledger } = fixture()
  const err = await failure(
    runApproved(
      { approval: ledger.approval },
      { approvalId: 'missing', digest: approvalDigest(ACTION), now: T0 },
      () => 'nope'
    )
  )
  expect(rejectionCode(err)).toBe('approval_not_found')
})
