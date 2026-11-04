// Vitest: the human approval surface over a REAL ledger (Node in-memory SQLite), driven through
// the HTTP seam. Covers the QC P3 findings this task owns: requestId idempotency (B3), the error
// taxonomy (B5), the byte cap/413 (B7), exact route matching (B12/L3), the approved list (B4),
// fixed human identity (M1, now derived from the transport credential), and the task review transitions (E2E B1/B2).
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { approvalHumanRoute, type HumanApprovalDeps } from './approvalHumanApi'
import { LOOPBACK_ACTOR, ROOT_ACTOR } from './approvalHumanRoutes'
import { APPROVAL_MAX_BODY_BYTES } from './approvalHttp'
import { memoryLedgerRuntime, seedProject, seedReviewTask } from './approvalTestRuntime.testutil'

const REQ = 'req-00000001'
/** fetch() from the webterm page itself: the only caller the UI-only policy admits. */
const BROWSER = { 'sec-fetch-site': 'same-origin' }

interface FakeRes {
  statusCode: number
  payload: string
  headers: Record<string, string>
  setHeader(name: string, value: string): void
  end(data?: string): void
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    payload: '',
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    end(data = '') {
      this.payload = data
    },
  }
}

interface CallInit {
  method?: string
  body?: string | Buffer
  headers?: Record<string, string>
}

async function call(
  deps: HumanApprovalDeps,
  path: string,
  init: CallInit = {}
): Promise<{ handled: boolean; status: number; json: Record<string, unknown> }> {
  const chunks = init.body === undefined ? [] : [Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body)]
  const req = Readable.from(chunks) as unknown as IncomingMessage
  req.method = init.method ?? (init.body === undefined ? 'GET' : 'POST')
  req.headers = { ...BROWSER, ...init.headers }
  const res = fakeRes()
  const handled = await approvalHumanRoute(
    req,
    res as unknown as ServerResponse,
    new URL(path, 'http://x'),
    deps
  )
  return {
    handled,
    status: res.statusCode,
    json: res.payload === '' ? {} : (JSON.parse(res.payload) as Record<string, unknown>),
  }
}

function setup(opts: { ledger?: boolean } = {}) {
  const { runtime, clock } = memoryLedgerRuntime()
  seedProject(runtime)
  const deps: HumanApprovalDeps = {
    runtime: opts.ledger === false ? null : runtime,
    now: () => clock.at,
    isNodeToken: () => false,
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(deps, path, { method: 'POST', body: JSON.stringify(body), headers })
  const request = (body: Record<string, unknown>) =>
    post('/api/approvals/request', { requestId: REQ, projectId: 'p1', kind: 'deploy', request: { a: 1 }, ...body })
  return { runtime, clock, deps, call, post, request }
}

type Fixture = ReturnType<typeof setup>

async function challenge(f: Fixture, id: string) {
  const res = await f.call(f.deps, `/api/approvals/challenge?id=${id}`)
  return res.json
}

async function decide(
  f: Fixture,
  id: string,
  digest: unknown,
  nonce: unknown,
  approve = true,
  extra: Record<string, unknown> = {}
) {
  return f.post('/api/approvals/decide', {
    requestId: 'req-00000002',
    id,
    digest,
    nonce,
    approve,
    ...extra,
  })
}

async function approvedApproval(f: Fixture): Promise<{ id: string; digest: string }> {
  const created = await f.request({})
  const view = await challenge(f, String(created.json['id']))
  await decide(f, String(created.json['id']), view['digest'], view['nonce'])
  return { id: String(created.json['id']), digest: String(view['digest']) }
}

const TOKEN = 'root-secret'
const TOKEN_HEADERS = { 'x-webterm-token': TOKEN }

/** Task-event actors in write order, read straight from the audit table. */
function eventActors(f: Fixture, taskId: string): string[] {
  const db = f.runtime.db as unknown as {
    query(sql: string): { all(id: string): Array<{ actor: string }> }
  }
  return db.query('SELECT actor FROM event WHERE task_id = ? ORDER BY seq').all(taskId).map((r) => r.actor)
}

/** A claimed_done task plus the pending task approval a human decides on. */
async function taskApprovalFor(f: Fixture) {
  const task = seedReviewTask(f.runtime)
  const body = { kind: 'task', taskId: task.taskId, fence: task.fence, request: { itemId: task.taskId } }
  const id = String((await f.request(body)).json['id'])
  return { task, id, view: await challenge(f, id) }
}

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
  it('binds approvedBy to the credential and ignores body.actor', async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['', TOKEN_HEADERS, ROOT_ACTOR],
      [`?token=${TOKEN}`, {}, ROOT_ACTOR],
      ['', {}, LOOPBACK_ACTOR],
    ]
    for (const [suffix, headers, actor] of cases) {
      const f = setup()
      const created = await f.request({})
      const id = String(created.json['id'])
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

describe('body cap', () => {
  it('answers 413 for a declared oversize body before reading it', async () => {
    const f = setup()
    const res = await f.call(f.deps, '/api/approvals/request', {
      method: 'POST',
      body: '{}',
      headers: { 'content-length': String(APPROVAL_MAX_BODY_BYTES + 1) },
    })
    expect(res.status).toBe(413)
    expect(res.json).toEqual({ error: 'payload_too_large', max: APPROVAL_MAX_BODY_BYTES })
  })

  it('answers 413 for a chunked oversize body', async () => {
    const f = setup()
    const res = await f.call(f.deps, '/api/approvals/request', {
      method: 'POST',
      body: 'a'.repeat(APPROVAL_MAX_BODY_BYTES + 10),
    })
    expect(res.status).toBe(413)
    expect(res.json['error']).toBe('payload_too_large')
  })

  it('counts bytes, not UTF-16 units', async () => {
    const f = setup()
    // 5000 chars, 10000 bytes: under the char count, over the byte cap.
    const res = await f.call(f.deps, '/api/approvals/request', {
      method: 'POST',
      body: JSON.stringify({ pad: 'é'.repeat(5000) }),
    })
    expect(res.status).toBe(413)
  })

  it('keeps invalid JSON as 400', async () => {
    const f = setup()
    const res = await f.call(f.deps, '/api/approvals/request', { method: 'POST', body: '{oops' })
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'invalid_json' })
  })
})

describe('route matching', () => {
  it('does not shadow sibling paths and answers unknown subroutes with 404', async () => {
    const f = setup()
    expect((await f.call(f.deps, '/api/approvalsXYZ')).handled).toBe(false)
    expect((await f.call(f.deps, '/api/approvals/nope', { method: 'POST', body: '{}' })).json).toEqual({
      error: 'not_found',
    })
    expect((await f.call(f.deps, '/api/approvals/challenge')).status).toBe(400)
    expect((await f.call(f.deps, '/api/approvals/challenge?id=nope')).json).toEqual({
      error: 'approval_not_found',
    })
    expect((await f.call(f.deps, '/api/approvals/decide', { method: 'DELETE' })).status).toBe(405)
    expect((await f.call(f.deps, '/api/approvals')).json).toEqual({ error: 'invalid_status' })
  })

  it('gates on the UI-only policy and answers 503 without a ledger', async () => {
    const f = setup()
    const curl = await f.call(f.deps, '/api/approvals/challenge?id=x', { headers: { 'sec-fetch-site': '' } })
    expect([curl.status, curl.json]).toEqual([403, { error: 'approval_browser_only' }])
    const off = setup({ ledger: false })
    expect((await off.call(off.deps, '/api/approvals/challenge?id=x')).status).toBe(503)
  })
})

describe('approved-but-unconsumed list', () => {
  it('lists only approved, unconsumed approvals with pagination', async () => {
    const f = setup()
    const one = await approvedApproval(f)
    await f.request({ requestId: 'req-00000005', request: { a: 2 } })

    const page = await f.call(f.deps, '/api/approvals?status=approved&limit=1&offset=0')
    expect(page.status).toBe(200)
    const body = page.json as unknown as { items: Array<Record<string, unknown>>; total: number; limit: number; offset: number }
    expect(body.total).toBe(1)
    expect(body.limit).toBe(1)
    expect(body.offset).toBe(0)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ id: one.id, digest: one.digest, kind: 'deploy', projectId: 'p1' })
    // Consent that cannot transition a task names no task and carries no fence.
    expect(body.items[0]).toMatchObject({ taskId: null, request: { a: 1 } })
    expect(body.items[0]).not.toHaveProperty('fence')

    const consumed = await f.post('/api/approvals/consume', { requestId: 'req-00000006', id: one.id, digest: one.digest })
    expect(consumed.status).toBe(200)
    const after = await f.call(f.deps, '/api/approvals?status=approved')
    expect((after.json as unknown as { total: number }).total).toBe(0)
  })

  it('derives taskId and fence from request_json for a payload-only task approval', async () => {
    const f = setup()
    const task = seedReviewTask(f.runtime)
    // The UI path sends the task reference inside `request`, so `approval.task_id` stays NULL.
    const created = await f.request({
      kind: 'task',
      request: { itemId: task.taskId, taskId: task.taskId, fence: task.fence, title: 'Review task', detail: null },
    })
    expect(created.status).toBe(201)
    const id = String(created.json['id'])
    const view = await challenge(f, id)
    expect((await decide(f, id, view['digest'], view['nonce'])).status).toBe(200)

    const page = await f.call(f.deps, '/api/approvals?status=approved')
    expect(page.status).toBe(200)
    const body = page.json as unknown as { items: Array<Record<string, unknown>>; total: number }
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({
      id,
      projectId: 'p1',
      taskId: task.taskId,
      fence: task.fence,
      kind: 'task',
      digest: view['digest'],
      request: expect.objectContaining({ itemId: task.taskId, taskId: task.taskId, fence: task.fence }),
    })
  })

  it('validates paging and status', async () => {
    const f = setup()
    expect((await f.call(f.deps, '/api/approvals?status=pending')).json).toEqual({ error: 'invalid_status' })
    expect((await f.call(f.deps, '/api/approvals?status=approved&limit=0')).json).toEqual({ error: 'invalid_limit' })
    expect((await f.call(f.deps, '/api/approvals?status=approved&offset=-1')).json).toEqual({ error: 'invalid_offset' })
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
