import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CapabilityStore, allows } from './capabilities'
import {
  APPROVAL_ROUTES,
  handleApproval,
  type ApprovalDeps,
  type ApprovalLedgerPort,
} from './approvalApi'
import {
  approvalDigest,
  consumeApproval,
  decideApproval,
  getApproval,
  listApprovals,
  requestApproval,
} from '../ledger/ledgerApproval'
import type { LedgerContext } from '../ledger/ledgerCore'
import type { ControlRequest, ControlResult } from './controlTypes'

const T0 = 1_700_000_000_000
const REQ = 'req-00000001'

// Real `ledgerApproval` against Node's in-memory SQLite. bun:sqlite's runtime is not available in
// vitest, so the tiny adapter below gives the same query/get/all/run surface ledgerCore expects.
const DDL = `
CREATE TABLE decision (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, question TEXT NOT NULL, choice TEXT,
  rationale TEXT, decided_by TEXT NOT NULL DEFAULT 'human', action_digest TEXT, nonce TEXT,
  scope TEXT, expires_at INTEGER, single_use INTEGER NOT NULL DEFAULT 0, supersedes TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE approval (
  id TEXT PRIMARY KEY, project_id TEXT, decision_id TEXT, task_id TEXT, kind TEXT NOT NULL,
  request_json TEXT, status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired')),
  approved_by TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`

type Bind = null | number | bigint | string | Uint8Array

function memoryDb(): LedgerContext['db'] {
  const raw = new DatabaseSync(':memory:')
  raw.exec(DDL)
  const bind = (params: unknown[]) => params as Bind[]
  return {
    query(sql: string) {
      const st = raw.prepare(sql)
      return {
        get: (...p: unknown[]) =>
          (st.get(...bind(p)) as Record<string, unknown> | undefined) ?? null,
        all: (...p: unknown[]) => st.all(...bind(p)) as Record<string, unknown>[],
        run: (...p: unknown[]) => {
          const r = st.run(...bind(p)) as { changes: number | bigint; lastInsertRowid: number | bigint }
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
        },
      }
    },
    exec(sql: string) {
      raw.exec(sql)
    },
  } as unknown as LedgerContext['db']
}

function fixture() {
  const clock = { at: T0 }
  const ctx: LedgerContext = { db: memoryDb(), now: () => clock.at }
  const ledger: ApprovalLedgerPort = {
    requestApproval: (input) => requestApproval(ctx, input),
    getApproval: (id) => getApproval(ctx, id),
    decideApproval: (id, input) => decideApproval(ctx, id, input),
    consumeApproval: (id, input) => consumeApproval(ctx, id, input),
    listApprovals: (opts) => listApprovals(ctx, opts),
  }
  const store = new CapabilityStore()
  const deps: ApprovalDeps = {
    capabilities: { verify: (token, now = clock.at) => store.verify(token, now), allows },
    approval: ledger,
    now: () => clock.at,
  }
  const mint = (verb: Parameters<CapabilityStore['mint']>[0]['verb'], resource: string, ttlMs?: number) =>
    store.mint({ verb, resource, ttlMs }, T0)
  return { clock, store, deps, ledger, mint }
}

type Fixture = ReturnType<typeof fixture>

function call(
  deps: ApprovalDeps,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<ControlResult> {
  const req: ControlRequest = {
    method,
    path,
    body,
    headers: { ...(token ? { 'x-webterm-capability': token } : {}), ...headers },
  }
  return handleApproval(req, deps)
}

const bodyOf = (result: ControlResult): Record<string, unknown> =>
  (result?.body ?? {}) as Record<string, unknown>

async function createApproval(
  f: Fixture,
  request: unknown = { branch: 'main' },
  ttlMs = 60_000,
  requestId = REQ
) {
  const token = f.mint('approval.request', 'project:p1')
  const res = await call(f.deps, 'POST', APPROVAL_ROUTES.request, {
    requestId,
    projectId: 'p1',
    kind: 'push',
    request,
    ttlMs,
  }, token)
  return { res, challenge: bodyOf(res), token }
}

async function approve(f: Fixture, challenge: Record<string, unknown>) {
  const token = f.mint('approval.decide', 'project:p1')
  return call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
    requestId: REQ,
    id: challenge.id,
    approve: true,
    digest: challenge.digest,
    nonce: challenge.nonce,
    actor: 'human',
  }, token)
}

describe('approval.request', () => {
  it('creates a challenge with id, digest, nonce and expiry', async () => {
    const f = fixture()
    const { res, challenge } = await createApproval(f)
    expect(res?.status).toBe(201)
    expect(Object.keys(challenge).sort()).toEqual(['digest', 'expiresAt', 'id', 'nonce'])
    expect(challenge.digest).toBe(approvalDigest({ branch: 'main' }))
    expect(challenge.expiresAt).toBe(T0 + 60_000)
    expect(typeof challenge.nonce).toBe('string')
    expect(f.ledger.getApproval(String(challenge.id))?.status).toBe('pending')
  })

  it('rejects missing, invalid and expired capabilities with 401', async () => {
    const f = fixture()
    const body = { requestId: REQ, projectId: 'p1', kind: 'push', request: {} }
    expect((await call(f.deps, 'POST', APPROVAL_ROUTES.request, body))?.status).toBe(401)
    expect((await call(f.deps, 'POST', APPROVAL_ROUTES.request, body, 'wcap_bogus'))?.status).toBe(401)
    const short = f.mint('approval.request', 'project:p1', 1000)
    f.clock.at = T0 + 1000
    expect((await call(f.deps, 'POST', APPROVAL_ROUTES.request, body, short))?.status).toBe(401)
  })

  it('never treats the root token as consent', async () => {
    const f = fixture()
    const res = await call(
      f.deps,
      'POST',
      APPROVAL_ROUTES.request,
      { requestId: REQ, projectId: 'p1', kind: 'push', request: {} },
      undefined,
      { 'x-webterm-token': 'root-secret' }
    )
    expect(res?.status).toBe(401)
    expect(JSON.stringify(res?.body)).not.toContain('root-secret')
  })

  it('requires the capability to cover the requested project', async () => {
    const f = fixture()
    const token = f.mint('approval.request', 'project:p2')
    const res = await call(f.deps, 'POST', APPROVAL_ROUTES.request, {
      requestId: REQ, projectId: 'p1', kind: 'push', request: {},
    }, token)
    expect(res?.status).toBe(403)
  })

  it('replays the same requestId without creating a second row', async () => {
    const f = fixture()
    const token = f.mint('approval.request', 'project:p1')
    const body = { requestId: REQ, projectId: 'p1', kind: 'push', request: { a: 1 } }
    const first = await call(f.deps, 'POST', APPROVAL_ROUTES.request, body, token)
    const second = await call(f.deps, 'POST', APPROVAL_ROUTES.request, body, token)
    expect(bodyOf(second)).toEqual(bodyOf(first))
    expect(f.ledger.listApprovals({ projectId: 'p1' })).toHaveLength(1)
  })

  it('forwards taskId so a review can be linked to its task', async () => {
    const f = fixture()
    const token = f.mint('approval.request', 'project:p1')
    const res = await call(f.deps, 'POST', APPROVAL_ROUTES.request, {
      requestId: REQ, projectId: 'p1', kind: 'task', taskId: 't1', request: { itemId: 't1' },
    }, token)
    expect(res?.status).toBe(201)
    expect(f.ledger.getApproval(String(bodyOf(res).id))?.taskId).toBe('t1')
  })

  it('rejects a malformed taskId', async () => {
    const f = fixture()
    const token = f.mint('approval.request', 'project:p1')
    const res = await call(f.deps, 'POST', APPROVAL_ROUTES.request, {
      requestId: REQ, projectId: 'p1', kind: 'task', taskId: '', request: {},
    }, token)
    expect(res?.status).toBe(400)
    expect(bodyOf(res).error).toBe('invalid_task_id')
  })

  it('validates requestId, kind, request and ttl', async () => {
    const f = fixture()
    const token = f.mint('approval.request', 'project:p1')
    const base = { requestId: REQ, projectId: 'p1', kind: 'push', request: {} }
    const cases = [
      { ...base, requestId: 'short' },
      { ...base, kind: '' },
      { ...base, request: undefined },
      { ...base, ttlMs: -1 },
      { ...base, ttlMs: 'soon' },
    ]
    for (const body of cases) {
      expect((await call(f.deps, 'POST', APPROVAL_ROUTES.request, body, token))?.status).toBe(400)
    }
  })
})

describe('approval.decide', () => {
  it('approves with digest+nonce and returns audit fields without the token', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f)
    const token = f.mint('approval.decide', 'project:p1')
    const res = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      requestId: REQ,
      id: challenge.id,
      approve: true,
      digest: challenge.digest,
      nonce: challenge.nonce,
      actor: 'human:alice',
    }, token)
    expect(res?.status).toBe(200)
    const body = bodyOf(res)
    expect(body).toMatchObject({
      ok: true,
      requestId: REQ,
      id: challenge.id,
      status: 'approved',
      approvedBy: 'human:alice',
      actor: 'human:alice',
      decidedAt: T0,
    })
    expect(JSON.stringify(body)).not.toContain(token)
    expect(f.ledger.getApproval(String(challenge.id))?.status).toBe('approved')
  })

  it('rejects a wrong digest and a wrong nonce with 403', async () => {
    const f = fixture()
    const a = await createApproval(f, { branch: 'main' })
    const decideToken = f.mint('approval.decide', 'project:p1')
    const base = {
      requestId: REQ, id: a.challenge.id, approve: true,
      digest: a.challenge.digest, nonce: a.challenge.nonce, actor: 'human',
    }
    const badDigest = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      ...base, digest: approvalDigest({ branch: 'other' }),
    }, decideToken)
    expect(badDigest?.status).toBe(403)
    expect(bodyOf(badDigest).error).toBe('digest_mismatch')
    const badNonce = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      ...base, nonce: 'wrong-nonce',
    }, decideToken)
    expect(badNonce?.status).toBe(403)
    expect(bodyOf(badNonce).error).toBe('nonce_mismatch')
    expect(f.ledger.getApproval(String(a.challenge.id))?.status).toBe('pending')
  })

  it('rejects a decision outside the capability project scope', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f)
    const token = f.mint('approval.decide', 'project:p2')
    const res = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      requestId: REQ, id: challenge.id, approve: true,
      digest: challenge.digest, nonce: challenge.nonce, actor: 'human',
    }, token)
    expect(res?.status).toBe(403)
  })

  it('rejects a node.read capability and an unknown approval', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f)
    const nodeToken = f.mint('node.read', 'node:a')
    expect((await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      requestId: REQ, id: challenge.id, approve: true,
      digest: challenge.digest, nonce: challenge.nonce, actor: 'human',
    }, nodeToken))?.status).toBe(403)

    const decideToken = f.mint('approval.decide', 'project:p1')
    expect((await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      requestId: REQ, id: 'missing-id', approve: true, digest: 'd', nonce: 'n', actor: 'human',
    }, decideToken))?.status).toBe(404)
  })

  it('returns 400 for invalid fields and 409 after expiry', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f, {}, 1000)
    const token = f.mint('approval.decide', 'project:p1')
    const base = {
      requestId: REQ, id: challenge.id, approve: true,
      digest: challenge.digest, nonce: challenge.nonce, actor: 'human',
    }
    expect((await call(f.deps, 'POST', APPROVAL_ROUTES.decide, {
      ...base, approve: 'yes',
    }, token))?.status).toBe(400)
    f.clock.at = T0 + 1500
    const expired = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, base, token)
    expect(expired?.status).toBe(409)
    expect(bodyOf(expired).error).toBe('approval_expired')
  })

  it('is idempotent per requestId after the decision lands', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f)
    const token = f.mint('approval.decide', 'project:p1')
    const body = {
      requestId: REQ, id: challenge.id, approve: true,
      digest: challenge.digest, nonce: challenge.nonce, actor: 'human',
    }
    const first = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, body, token)
    f.clock.at = T0 + 5000
    const second = await call(f.deps, 'POST', APPROVAL_ROUTES.decide, body, token)
    expect(second).toEqual(first)
  })
})

describe('approval.consume', () => {
  it('consumes exactly once and 409s on a second one-shot attempt', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f)
    const consumeToken = f.mint('approval.consume', 'project:p1')
    const target = {
      requestId: REQ, id: challenge.id, digest: challenge.digest,
    }
    const before = await call(f.deps, 'POST', APPROVAL_ROUTES.consume, target, consumeToken)
    expect(before?.status).toBe(409)
    expect((await approve(f, challenge))?.status).toBe(200)

    const first = await call(f.deps, 'POST', APPROVAL_ROUTES.consume, target, consumeToken)
    expect(first?.status).toBe(200)
    expect(bodyOf(first)).toMatchObject({ ok: true, id: challenge.id, consumed: true })
    const second = await call(f.deps, 'POST', APPROVAL_ROUTES.consume, {
      ...target, requestId: 'req-00000002',
    }, consumeToken)
    expect(second?.status).toBe(409)
    expect(bodyOf(second).error).toBe('not_consumable')
  })

  it('replays the same requestId instead of re-running the check', async () => {
    const f = fixture()
    const { challenge } = await createApproval(f)
    expect((await approve(f, challenge))?.status).toBe(200)
    const token = f.mint('approval.consume', 'project:p1')
    const body = { requestId: REQ, id: challenge.id, digest: challenge.digest }
    const first = await call(f.deps, 'POST', APPROVAL_ROUTES.consume, body, token)
    expect(first?.status).toBe(200)
    const second = await call(f.deps, 'POST', APPROVAL_ROUTES.consume, body, token)
    expect(second).toEqual(first)
    const other = await call(f.deps, 'POST', APPROVAL_ROUTES.consume, {
      ...body, requestId: 'req-00000002',
    }, token)
    expect(other?.status).toBe(409)
  })
})

describe('approval.list', () => {
  it('lists only the authorized project and filters by status', async () => {
    const f = fixture()
    const a = await createApproval(f, { n: 1 }, 60_000, 'req-00000001')
    const b = await createApproval(f, { n: 2 }, 60_000, 'req-00000002')
    const otherToken = f.mint('approval.request', 'project:p2')
    await call(f.deps, 'POST', APPROVAL_ROUTES.request, {
      requestId: 'req-00000009', projectId: 'p2', kind: 'push', request: { n: 3 },
    }, otherToken)

    const readToken = f.mint('approval.read', 'project:p1')
    const res = await call(f.deps, 'GET', `${APPROVAL_ROUTES.list}?projectId=p1&status=pending`, undefined, readToken)
    expect(res?.status).toBe(200)
    const rows = res?.body as Array<Record<string, unknown>>
    expect(rows.map((r) => r.id).sort()).toEqual([a.challenge.id, b.challenge.id].sort())
    expect(rows.every((r) => r.status === 'pending')).toBe(true)

    const filtered = await call(f.deps, 'GET', `${APPROVAL_ROUTES.list}?projectId=p1&status=approved`, undefined, readToken)
    expect(filtered?.body).toEqual([])
  })

  it('validates capability scope, projectId, status and limit', async () => {
    const f = fixture()
    const wrong = f.mint('approval.read', 'project:p2')
    expect((await call(f.deps, 'GET', `${APPROVAL_ROUTES.list}?projectId=p1`, undefined, wrong))?.status).toBe(403)
    const read = f.mint('approval.read', 'project:p1')
    expect((await call(f.deps, 'GET', APPROVAL_ROUTES.list, undefined, read))?.status).toBe(400)
    expect((await call(f.deps, 'GET', `${APPROVAL_ROUTES.list}?projectId=p1&status=bogus`, undefined, read))?.status).toBe(400)
    expect((await call(f.deps, 'GET', `${APPROVAL_ROUTES.list}?projectId=p1&limit=0`, undefined, read))?.status).toBe(400)
    expect((await call(f.deps, 'GET', `${APPROVAL_ROUTES.list}?projectId=p1`, undefined, read))?.status).toBe(200)
  })
})

describe('router boundaries', () => {
  it('returns null outside the family or for unknown methods', async () => {
    const f = fixture()
    expect(await call(f.deps, 'POST', '/api/control/spawn', {})).toBeNull()
    expect(await call(f.deps, 'POST', '/api/control/approval/nope', {})).toBeNull()
    expect(await call(f.deps, 'GET', APPROVAL_ROUTES.decide)).toBeNull()
  })
})
