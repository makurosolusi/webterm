// Defence-in-depth: the control approval API must reject a digest that does not match the stored
// action BEFORE calling the ledger port. The port validates too, but its error is re-mapped to the
// same 403, so only a port that accepts anything can prove the API-layer guard exists (QC S5).

import { describe, expect, it } from 'vitest'
import { CapabilityStore, allows } from './capabilities'
import {
  APPROVAL_ROUTES,
  handleApproval,
  type ApprovalDeps,
  type ApprovalLedgerPort,
} from './approvalApi'
import { approvalDigest, type Approval } from '../ledger/ledgerApproval'

const T0 = 1_700_000_000_000
const approvedAction = { branch: 'main' }
const stored: Approval = {
  id: 'ap-digest-1',
  projectId: 'p1',
  taskId: null,
  kind: 'push',
  request: approvedAction,
  status: 'pending',
  approvedBy: null,
  expiresAt: T0 + 60_000,
  createdAt: T0,
  updatedAt: T0,
}

function fixture() {
  const store = new CapabilityStore()
  const decided: unknown[] = []
  const port: ApprovalLedgerPort = {
    requestApproval() {
      throw new Error('not used')
    },
    getApproval: (id) => (id === stored.id ? stored : null),
    // Deliberately does NOT validate digest or nonce: it approves whatever it is given.
    decideApproval: (id, input) => {
      decided.push({ id, input })
      return { ...stored, status: 'approved', approvedBy: input.actor, updatedAt: T0 }
    },
    consumeApproval: () => false,
    listApprovals: () => [],
  }
  const deps: ApprovalDeps = {
    capabilities: { verify: (token, now = T0) => store.verify(token, now), allows },
    approval: port,
    now: () => T0,
  }
  const token = store.mint({ verb: 'approval.decide', resource: 'project:p1' }, T0)
  return { deps, decided, token }
}

function decide(deps: ApprovalDeps, token: string, requestId: string, digest: string) {
  return handleApproval(
    {
      method: 'POST',
      path: APPROVAL_ROUTES.decide,
      headers: { 'x-webterm-capability': token },
      body: {
        requestId,
        id: stored.id,
        approve: true,
        digest,
        nonce: 'nonce-1',
        actor: 'human',
      },
    },
    deps
  )
}

describe('approval.decide digest pre-check', () => {
  it('rejects a wrong digest at the API layer and never calls the port', async () => {
    const { deps, decided, token } = fixture()
    const wrong = approvalDigest({ branch: 'other' })

    const res = await decide(deps, token, 'req-digest01', wrong)

    expect(res).toEqual({ status: 403, body: { error: 'digest_mismatch' } })
    expect(decided).toEqual([])
  })

  it('passes the matching digest through to the port', async () => {
    const { deps, decided, token } = fixture()

    const res = await decide(deps, token, 'req-digest02', approvalDigest(approvedAction))

    expect(res?.status).toBe(200)
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({ id: stored.id, input: { actor: 'human', approve: true } })
  })
})
