// The human approval surface prefers the durable ack journal; a runtime whose db has no `query`
// (node-env fakes) falls back to one in-memory store per runtime object. That fallback must still
// replay a retried requestId, not rebuild the store per call (QC S6).

import { describe, expect, it } from 'vitest'
import { durableAckFor } from './ledger/durableAck'
import type { Approval } from './ledger/ledgerApproval'
import { approvalDigest } from './ledger/ledgerApproval'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { decideRoute } from './approvalHumanRoutes'

const T0 = 1_700_000_000_000
const REQ = 'req-fallback1'

const pending: Approval = {
  id: 'ap-fallback-1',
  projectId: 'p1',
  taskId: null,
  kind: 'push',
  request: { branch: 'main' },
  status: 'pending',
  approvedBy: null,
  expiresAt: T0 + 60_000,
  createdAt: T0,
  updatedAt: T0,
}

function runtimeWithoutQuery() {
  const decisions: unknown[] = []
  const runtime = {
    mode: 'on',
    path: ':memory:',
    // No `query` on purpose: `durableAckFor` must return undefined so the in-memory branch runs.
    db: {},
    close() {},
    ledger: {
      approval: {
        requestApproval() {
          throw new Error('not used')
        },
        getApproval: (id: string) => (id === pending.id ? pending : null),
        decideApproval: (id: string, input: { actor: string }) => {
          decisions.push({ id, input })
          return { ...pending, status: 'approved', approvedBy: input.actor, updatedAt: T0 }
        },
        consumeApproval: () => false,
        listApprovals: () => [],
      },
    },
  } as unknown as LedgerRuntime
  return { runtime, decisions }
}

describe('human approval ack fallback', () => {
  it('replays the same requestId through one in-memory store per runtime', () => {
    const { runtime, decisions } = runtimeWithoutQuery()
    expect(durableAckFor(runtime.db, 'human')).toBeUndefined()

    const body = {
      requestId: REQ,
      id: pending.id,
      digest: approvalDigest(pending.request),
      nonce: 'nonce-1',
      approve: true,
    }

    const first = decideRoute(runtime, body, T0)
    const replay = decideRoute(runtime, body, T0)

    expect(first).toEqual({ status: 200, body: { id: pending.id, status: 'approved' } })
    expect(replay).toEqual(first)
    // The decision landed once: the second call replayed the ack instead of re-deciding.
    expect(decisions).toHaveLength(1)
  })
})
