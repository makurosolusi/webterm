// Vitest: the human approval surface over a REAL ledger (in-memory SQLite) through the HTTP seam:
// requestId idempotency (B3), error taxonomy (B5), credential-derived human identity (M1), task
// review transitions (E2E B1/B2). The 413 byte cap (B7), exact routes (B12/L3) and approved list
// (B4) live in approvalHumanApi.http.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOOPBACK_ACTOR, ROOT_ACTOR } from './approvalHumanRoutes'
import { seedReviewTask } from './approvalTestRuntime.testutil'
import { setTokenState } from './tokenBootstrap'
import {
  TOKEN,
  TOKEN_HEADERS,
  challenge,
  decide,
  eventActors,
  setup,
  taskApprovalFor,
  type Fixture,
} from './approvalHumanApi.testutil'

describe('request idempotency', () => {
  it('replays one stable acknowledgement for the same requestId', async () => {
    const f = setup()
    const first = await f.request({})
    const second = await f.request({})
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.json).toEqual(first.json)
    const rows = f.runtime.ledger.approval.listApprovals({ projectId: 'p1' })
    expect(rows).toHaveLength(1)
  })

  it('still creates a new approval for a new requestId', async () => {
    const f = setup()
    const first = await f.request({})
    const second = await f.request({ requestId: 'req-00000009' })
    expect(second.json['id']).not.toBe(first.json['id'])
    expect(f.runtime.ledger.approval.listApprovals({ projectId: 'p1' })).toHaveLength(2)
  })

  it('replays the decide acknowledgement instead of 409ing on retry', async () => {
    const f = setup()
    const created = await f.request({})
    const view = await challenge(f, String(created.json['id']))
    const body = {
      requestId: 'req-00000003',
      id: created.json['id'],
      digest: view['digest'],
      nonce: view['nonce'],
      approve: true,
    }
    const first = await f.post('/api/approvals/decide', body)
    const second = await f.post('/api/approvals/decide', body)
    expect(first.status).toBe(200)
    expect(second).toEqual(first)
  })
})

describe('request validation and identity', () => {
  it('validates kind, request, ttl and requestId', async () => {
    const f = setup()
    expect((await f.request({ requestId: 'short' })).json).toEqual({ error: 'invalid_requestId' })
    expect((await f.request({ kind: 'k'.repeat(129) })).json).toEqual({ error: 'invalid_kind' })
    expect((await f.request({ request: undefined })).json).toEqual({ error: 'invalid_request' })
    expect((await f.request({ ttlMs: -5 })).json).toEqual({ error: 'invalid_ttl' })
    expect((await f.request({ ttlMs: '60000' })).json).toEqual({ error: 'invalid_ttl' })
    expect((await f.request({ projectId: 'ghost' })).status).toBe(404)
    expect((await f.request({ projectId: 'ghost' })).json).toEqual({ error: 'project_not_found' })
    expect((await f.request({ taskId: 't1' })).json).toEqual({ error: 'invalid_fence' })
  })
})

describe('principal-derived actor', () => {
  beforeEach(() => setTokenState({ token: TOKEN, source: 'file', created: false }))
  afterEach(() => setTokenState({ token: undefined, source: 'none', created: false }))
  it('binds approvedBy to the credential and ignores body.actor', async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['', TOKEN_HEADERS, ROOT_ACTOR],
      [`?token=${TOKEN}`, {}, LOOPBACK_ACTOR], // the query is never a credential
      ['', { 'x-webterm-token': 'not-the-root' }, LOOPBACK_ACTOR],
      ['', {}, LOOPBACK_ACTOR],
    ]
    for (const [suffix, headers, actor] of cases) {
      const f = setup()
      const id = String((await f.request({})).json['id'])
      const view = await challenge(f, id)
      const res = await f.post(
        `/api/approvals/decide${suffix}`,
        {
          requestId: 'req-00000020',
          id,
          digest: view['digest'],
          nonce: view['nonce'],
          approve: true,
          actor: 'mallory',
        },
        headers
      )
      expect(res.status).toBe(200)
      expect(f.runtime.ledger.approval.getApproval(id)?.approvedBy).toBe(actor)
    }
  })

  it('records the derived actor on the task verify and reject events', async () => {
    const verified = setup()
    const v = await taskApprovalFor(verified)
    const approve = {
      requestId: 'req-00000030',
      id: v.id,
      digest: v.view['digest'],
      nonce: v.view['nonce'],
      approve: true,
    }
    expect((await verified.post('/api/approvals/decide', approve, TOKEN_HEADERS)).status).toBe(200)
    const consumeBody = { requestId: 'req-00000031', id: v.id, digest: v.view['digest'] }
    const consume = await verified.post('/api/approvals/consume', consumeBody, TOKEN_HEADERS)
    expect(consume.status).toBe(200)
    expect(eventActors(verified, v.task.taskId).at(-1)).toBe(ROOT_ACTOR)

    const rejected = setup()
    const r = await taskApprovalFor(rejected)
    const deny = {
      requestId: 'req-00000032',
      id: r.id,
      digest: r.view['digest'],
      nonce: r.view['nonce'],
      approve: false,
    }
    expect((await rejected.post('/api/approvals/decide', deny)).status).toBe(200)
    expect(eventActors(rejected, r.task.taskId).at(-1)).toBe(LOOPBACK_ACTOR)
  })
})

describe('decision error taxonomy', () => {
  it('separates digest, nonce, state and missing-row failures', async () => {
    const f = setup()
    const created = await f.request({ ttlMs: 60_000 })
    const id = String(created.json['id'])
    const view = await challenge(f, id)

    const wrongDigest = await decide(f, id, 'f'.repeat(64), view['nonce'])
    expect(wrongDigest.status).toBe(403)
    expect(wrongDigest.json).toEqual({ error: 'digest_mismatch' })

    const wrongNonce = await decide(f, id, view['digest'], 'bogus-nonce')
    expect(wrongNonce.status).toBe(403)
    expect(wrongNonce.json).toEqual({ error: 'nonce_mismatch' })

    expect((await decide(f, 'missing-id', view['digest'], view['nonce'])).status).toBe(404)

    expect((await decide(f, id, view['digest'], view['nonce'])).status).toBe(200)
    const again = await decide(f, id, view['digest'], view['nonce'], true, { requestId: 'req-00000004' })
    expect(again.status).toBe(409)
    expect(again.json).toEqual({ error: 'approval_not_pending' })
  })

  it('reports expiry as 409 approval_expired', async () => {
    const f = setup()
    const created = await f.request({ ttlMs: 1000 })
    const id = String(created.json['id'])
    const view = await challenge(f, id)
    f.clock.at += 2000
    const expired = await decide(f, id, view['digest'], view['nonce'])
    expect(expired.status).toBe(409)
    expect(expired.json).toEqual({ error: 'approval_expired' })
    // The challenge reports the lazy expiry instead of a stale `pending`.
    expect((await challenge(f, id))['status']).toBe('expired')
  })
})

describe('task review transitions', () => {
  async function taskApproval(f: Fixture, tail: Record<string, unknown> = {}) {
    const task = seedReviewTask(f.runtime)
    const created = await f.request({
      kind: 'task',
      taskId: task.taskId,
      fence: task.fence,
      request: { itemId: task.taskId, ...tail },
    })
    const id = String(created.json['id'])
    const view = await challenge(f, id)
    return { task, id, view }
  }

  it('approve then consume verifies the task and keeps the claim evidence', async () => {
    const f = setup()
    const { task, id, view } = await taskApproval(f)
    expect((await decide(f, id, view['digest'], view['nonce'])).status).toBe(200)
    expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('claimed_done')

    const consumed = await f.post('/api/approvals/consume', {
      requestId: 'req-00000007',
      id,
      digest: view['digest'],
    })
    expect(consumed.status).toBe(200)
    expect(consumed.json).toMatchObject({ ok: true, taskId: task.taskId, taskStatus: 'verified' })
    const verified = f.runtime.ledger.task.getTask(task.taskId)
    expect(verified?.status).toBe('verified')
    expect(verified?.evidence).toMatchObject({ tests: 3 })
    expect(f.runtime.ledger.approval.consumeApproval(id, { digest: String(view['digest']) })).toBe(false)

    // A retry with the same requestId replays the 200; a new requestId is a one-shot 409.
    const replay = await f.post('/api/approvals/consume', {
      requestId: 'req-00000007',
      id,
      digest: view['digest'],
    })
    expect(replay.json).toEqual(consumed.json)
    const again = await f.post('/api/approvals/consume', {
      requestId: 'req-00000008',
      id,
      digest: view['digest'],
    })
    expect(again.status).toBe(409)
    expect(again.json).toEqual({ error: 'not_consumable' })
  })

  it('reject fails claimed work instead of verifying it', async () => {
    const f = setup()
    const { task, id, view } = await taskApproval(f)
    const rejected = await decide(f, id, view['digest'], view['nonce'], false)
    expect(rejected.status).toBe(200)
    expect(rejected.json['status']).toBe('rejected')
    expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('failed')
    // Approval rejected -> not consumable.
    expect(
      (await f.post('/api/approvals/consume', { requestId: 'req-00000010', id, digest: view['digest'] }))
        .status
    ).toBe(409)
  })

  it('refuses a stale fence before spending the decision', async () => {
    const f = setup()
    const task = seedReviewTask(f.runtime)
    const created = await f.request({
      kind: 'task',
      taskId: task.taskId,
      fence: task.fence - 1,
      request: { itemId: task.taskId },
    })
    const id = String(created.json['id'])
    const view = await challenge(f, id)
    const stale = await decide(f, id, view['digest'], view['nonce'])
    expect(stale.status).toBe(409)
    expect(stale.json).toEqual({ error: 'stale_fence' })
    expect(f.runtime.ledger.approval.getApproval(id)?.status).toBe('pending')
    expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('claimed_done')
  })

  it('refuses to verify a task that is no longer claimed_done', async () => {
    const f = setup()
    const { task, id, view } = await taskApproval(f)
    await decide(f, id, view['digest'], view['nonce'])
    // A claimed_done task can only move to failed/verified, so fail it (an operator closing it).
    f.runtime.ledger.task.failTask(task.taskId, task.fence, 'closed by operator', { actor: 'operator' })
    const res = await f.post('/api/approvals/consume', { requestId: 'req-00000011', id, digest: view['digest'] })
    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: 'task_not_pending' })
  })
})
