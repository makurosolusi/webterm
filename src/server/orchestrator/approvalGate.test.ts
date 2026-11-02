import { describe, expect, it } from 'vitest'
import { type Approval, approvalDigest } from '../ledger/ledgerApproval'
import { type ApprovalPort, ApprovalRequiredError, runApproved } from './approvalGate'

const T0 = 1_700_000_000_000

function record(patch: Partial<Approval> = {}): Approval {
  return {
    id: 'a1',
    projectId: 'p1',
    taskId: null,
    kind: 'push',
    request: { kind: 'git.push', branch: 'main', sha: 'abc' },
    status: 'approved',
    approvedBy: 'human',
    expiresAt: T0 + 60_000,
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  }
}

function gate(initial: Approval | null) {
  const order: string[] = []
  const consumes: { id: string; digest: string; now?: number }[] = []
  let consumed = false
  const approval: ApprovalPort = {
    getApproval: (id) => (initial && initial.id === id ? { ...initial } : null),
    consumeApproval: (id, input) => {
      order.push('consume')
      consumes.push({ id, ...input })
      if (!initial || initial.status !== 'approved' || consumed) return false
      if (input.now !== undefined && initial.expiresAt !== null && initial.expiresAt <= input.now) {
        return false
      }
      consumed = true
      return true
    },
  }
  return { approval, order, consumes }
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected rejection')
}

function digestOf(approval: Approval): string {
  return approvalDigest(approval.request)
}

describe('runApproved', () => {
  it('consumes once with digest + now, then runs the action', async () => {
    const approval = record()
    const { approval: port, order, consumes } = gate(approval)
    const result = await runApproved(
      { approval: port },
      { approvalId: 'a1', digest: digestOf(approval), now: T0 + 1000 },
      async () => {
        order.push('action')
        return 'pushed'
      }
    )

    expect(result).toBe('pushed')
    expect(order).toEqual(['consume', 'action'])
    expect(consumes).toEqual([{ id: 'a1', digest: digestOf(approval), now: T0 + 1000 }])
  })

  it('does not consume or run when the decision is still pending', async () => {
    const approval = record({ status: 'pending' })
    const { approval: port, order } = gate(approval)
    const err = await failure(
      runApproved({ approval: port }, { approvalId: 'a1', digest: digestOf(approval), now: T0 }, () => 'nope')
    )

    expect(err).toBeInstanceOf(ApprovalRequiredError)
    expect((err as ApprovalRequiredError).code).toBe('approval_pending')
    expect(order).toEqual([])
  })

  it('rejects a rejected decision', async () => {
    const approval = record({ status: 'rejected' })
    const { approval: port, order } = gate(approval)
    const err = await failure(
      runApproved({ approval: port }, { approvalId: 'a1', digest: digestOf(approval), now: T0 }, () => 'nope')
    )
    expect((err as ApprovalRequiredError).code).toBe('approval_rejected')
    expect(order).toEqual([])
  })

  it('rejects expiry by status or by expiresAt even when approved', async () => {
    const expired = record({ status: 'expired' })
    const first = await failure(
      runApproved(
        { approval: gate(expired).approval },
        { approvalId: 'a1', digest: digestOf(expired), now: T0 },
        () => 'nope'
      )
    )
    expect((first as ApprovalRequiredError).code).toBe('approval_expired')

    const stale = record()
    const { approval: port, order } = gate(stale)
    const second = await failure(
      runApproved(
        { approval: port },
        { approvalId: 'a1', digest: digestOf(stale), now: T0 + 60_000 },
        () => 'nope'
      )
    )
    expect((second as ApprovalRequiredError).code).toBe('approval_expired')
    expect(order).toEqual([])
  })

  it('rejects a different action digest before consuming', async () => {
    const approval = record()
    const { approval: port, order } = gate(approval)
    const err = await failure(
      runApproved(
        { approval: port },
        { approvalId: 'a1', digest: approvalDigest({ kind: 'git.push', branch: 'main', sha: 'other' }), now: T0 },
        () => 'nope'
      )
    )
    expect((err as ApprovalRequiredError).code).toBe('approval_digest_mismatch')
    expect(order).toEqual([])
  })

  it('rejects an unknown or missing approval', async () => {
    const err = await failure(
      runApproved({ approval: gate(null).approval }, { approvalId: 'a1', digest: 'abc', now: T0 }, () => 'nope')
    )
    expect((err as ApprovalRequiredError).code).toBe('approval_not_found')

    const empty = await failure(
      runApproved({ approval: gate(null).approval }, { approvalId: '  ', digest: 'abc' }, () => 'nope')
    )
    expect((empty as ApprovalRequiredError).code).toBe('approval_not_found')
  })

  it('does not re-enable approval when the action throws', async () => {
    const approval = record()
    const { approval: port, order } = gate(approval)
    const request = { approvalId: 'a1', digest: digestOf(approval), now: T0 + 1000 }

    const first = await failure(
      runApproved({ approval: port }, request, () => {
        order.push('action')
        throw new Error('push failed')
      })
    )
    expect(first).toBeInstanceOf(Error)
    expect((first as Error).message).toBe('push failed')

    const second = await failure(
      runApproved({ approval: port }, request, () => {
        order.push('retry')
        return 'nope'
      })
    )
    expect((second as ApprovalRequiredError).code).toBe('approval_already_consumed')
    expect(order).toEqual(['consume', 'action', 'consume'])
  })

  it('rejects when another consumer wins the single-use race', async () => {
    const approval = record()
    const { approval: port } = gate(approval)
    port.consumeApproval = () => false
    const err = await failure(
      runApproved({ approval: port }, { approvalId: 'a1', digest: digestOf(approval), now: T0 }, () => 'nope')
    )
    expect((err as ApprovalRequiredError).code).toBe('approval_already_consumed')
  })

  it('rejects an empty digest without touching the ledger', async () => {
    const approval = record()
    const { approval: port, order } = gate(approval)
    const err = await failure(
      runApproved({ approval: port }, { approvalId: 'a1', digest: '', now: T0 }, () => 'nope')
    )
    expect((err as ApprovalRequiredError).code).toBe('approval_digest_mismatch')
    expect(order).toEqual([])
  })
})
