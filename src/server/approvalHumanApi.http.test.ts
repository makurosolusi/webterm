// Vitest: the human approval HTTP seam over a REAL ledger (in-memory SQLite): 413 byte cap (B7),
// exact routes (B12/L3) and the approved-but-unconsumed list (B4). Decisions and task review
// transitions live in approvalHumanApi.test.ts.
import { describe, expect, it } from 'vitest'
import { APPROVAL_MAX_BODY_BYTES } from './approvalHttp'
import { seedReviewTask } from './approvalTestRuntime.testutil'
import { approvedApproval, challenge, decide, setup } from './approvalHumanApi.testutil'

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
