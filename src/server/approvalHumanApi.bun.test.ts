// Bun-only (needs bun:sqlite): the human approval HTTP seam over a REAL ledger created by
// `openLedgerDb` + `createLedger`. Covers the P3 gap this change owns: a task approval must name a
// resolvable task+fence (otherwise its consent can never transition the task), plus the full
// approve/consume/reject transitions and one-shot consumption.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { approvalHumanRoute, type HumanApprovalDeps } from './approvalHumanApi'
import { createLedger } from './ledger/ledger'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { openLedgerDb } from './ledger/migration'

const T0 = 1_700_000_000_000
const PROJECT_ID = 'p1'

const restartRoot = mkdtempSync(join(tmpdir(), 'approval-restart-'))
afterAll(() => rmSync(restartRoot, { recursive: true, force: true }))

interface Fixture {
  runtime: LedgerRuntime
  clock: { at: number }
  deps: HumanApprovalDeps
}

function fixture(
  path = ':memory:',
  existingClock?: { at: number },
  seed = true
): Fixture {
  const db = openLedgerDb(path)
  const clock = existingClock ?? { at: T0 }
  const ledger = createLedger(db, { now: () => clock.at })
  if (seed) {
    ledger.project.createProject({
      id: PROJECT_ID,
      workspaceId: 'w1',
      name: PROJECT_ID,
      path: `/tmp/${PROJECT_ID}`,
    })
  }
  const runtime: LedgerRuntime = {
    mode: 'on',
    path,
    db,
    ledger,
    close: () => (db as unknown as { close(): void }).close(),
  }
  return {
    runtime,
    clock,
    deps: { runtime, now: () => clock.at, authAllowed: () => true },
  }
}

interface FakeRes {
  statusCode: number
  payload: string
  setHeader(): void
  end(data?: string): void
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    payload: '',
    setHeader() {},
    end(data = '') {
      this.payload = data
    },
  }
}

async function call(
  f: Fixture,
  path: string,
  init: { method?: string; body?: string } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const chunks = init.body === undefined ? [] : [Buffer.from(init.body)]
  const req = Readable.from(chunks) as unknown as IncomingMessage
  req.method = init.method ?? (init.body === undefined ? 'GET' : 'POST')
  req.headers = {}
  const res = fakeRes()
  await approvalHumanRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), f.deps)
  return {
    status: res.statusCode,
    json: res.payload === '' ? {} : (JSON.parse(res.payload) as Record<string, unknown>),
  }
}

const post = (f: Fixture, path: string, body: unknown) =>
  call(f, path, { method: 'POST', body: JSON.stringify(body) })

/** A claimed_done task awaiting human review, with real fence/evidence. */
function seedClaimedTask(f: Fixture): { taskId: string; fence: number } {
  const task = f.runtime.ledger.task.createTask({ projectId: PROJECT_ID, spec: 'review me' })
  const leased = f.runtime.ledger.task.leaseTask(task.id, { owner: 'worker', ttlMs: 60_000 })
  if (!leased) throw new Error('fixture: lease failed')
  const claimed = f.runtime.ledger.task.claimDone(
    task.id,
    leased.fence,
    { tests: 3 },
    { owner: 'worker' }
  )
  return { taskId: claimed.id, fence: claimed.fence }
}

async function challenge(f: Fixture, id: string): Promise<Record<string, unknown>> {
  const res = await call(f, `/api/approvals/challenge?id=${id}`)
  return res.json
}

const approvalCount = (f: Fixture): number =>
  f.runtime.ledger.approval.listApprovals({ projectId: PROJECT_ID }).length

/** The bun:test shim only types `toBe`/`toContain`, so structural equality goes through JSON. */
const expectJson = (actual: unknown, expected: unknown): void =>
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))

test('task approvals without a taskId/fence are rejected before a row exists', async () => {
  const f = fixture()
  const base = { projectId: PROJECT_ID, kind: 'task', request: { itemId: 'x' } }

  const missingBoth = await post(f, '/api/approvals/request', { ...base, requestId: 'req-00000001' })
  expect(missingBoth.status).toBe(400)
  expectJson(missingBoth.json, { error: 'invalid_task_ref' })

  const missingFence = await post(f, '/api/approvals/request', {
    ...base,
    requestId: 'req-00000002',
    taskId: 't-1',
  })
  expect(missingFence.status).toBe(400)
  expectJson(missingFence.json, { error: 'invalid_task_ref' })

  // Payload spelling is checked too: negative, fractional and string fences are all refused.
  for (const fence of [-1, 1.5, '3']) {
    const res = await post(f, '/api/approvals/request', {
      ...base,
      requestId: 'req-00000003',
      request: { itemId: 'x', taskId: 't-1', fence },
    })
    expectJson(res, { status: 400, json: { error: 'invalid_task_ref' } })
  }

  const emptyId = await post(f, '/api/approvals/request', {
    ...base,
    requestId: 'req-00000004',
    request: { itemId: 'x', taskId: '   ', fence: 1 },
  })
  expectJson(emptyId.json, { error: 'invalid_task_ref' })

  // Namespaced task kinds are guarded as well.
  const namespaced = await post(f, '/api/approvals/request', {
    projectId: PROJECT_ID,
    kind: 'task.review',
    request: { itemId: 'x' },
    requestId: 'req-00000005',
  })
  expectJson(namespaced.json, { error: 'invalid_task_ref' })

  expect(approvalCount(f)).toBe(0)

  // Non-task approvals keep their old contract: no task ref required.
  const deploy = await post(f, '/api/approvals/request', {
    projectId: PROJECT_ID,
    kind: 'deploy',
    request: { a: 1 },
    requestId: 'req-00000006',
  })
  expect(deploy.status).toBe(201)
  expect(approvalCount(f)).toBe(1)
})

test('approve then consume verifies the task; a second consume is a 409 and leaves it verified', async () => {
  const f = fixture()
  const task = seedClaimedTask(f)
  const created = await post(f, '/api/approvals/request', {
    projectId: PROJECT_ID,
    kind: 'task',
    request: { itemId: task.taskId, taskId: task.taskId, fence: task.fence },
    requestId: 'req-00000101',
  })
  expect(created.status).toBe(201)
  const id = String(created.json['id'])
  const view = await challenge(f, id)

  const decided = await post(f, '/api/approvals/decide', {
    id,
    digest: view['digest'],
    nonce: view['nonce'],
    approve: true,
    requestId: 'req-00000102',
  })
  expect(decided.status).toBe(200)
  expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('claimed_done')

  const consumed = await post(f, '/api/approvals/consume', {
    id,
    digest: view['digest'],
    requestId: 'req-00000103',
  })
  expect(consumed.status).toBe(200)
  expect(consumed.json['ok']).toBe(true)
  expect(consumed.json['taskId']).toBe(task.taskId)
  expect(consumed.json['taskStatus']).toBe('verified')
  const verified = f.runtime.ledger.task.getTask(task.taskId)
  expect(verified?.status).toBe('verified')
  expect(JSON.stringify(verified?.evidence)).toBe(JSON.stringify({ tests: 3 }))

  const again = await post(f, '/api/approvals/consume', {
    id,
    digest: view['digest'],
    requestId: 'req-00000104',
  })
  expect(again.status).toBe(409)
  expectJson(again.json, { error: 'not_consumable' })
  expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('verified')
})

test('reject fails claimed work instead of verifying it', async () => {
  const f = fixture()
  const task = seedClaimedTask(f)
  const created = await post(f, '/api/approvals/request', {
    projectId: PROJECT_ID,
    kind: 'task',
    request: { itemId: task.taskId, taskId: task.taskId, fence: task.fence },
    requestId: 'req-00000201',
  })
  const id = String(created.json['id'])
  const view = await challenge(f, id)

  const rejected = await post(f, '/api/approvals/decide', {
    id,
    digest: view['digest'],
    nonce: view['nonce'],
    approve: false,
    requestId: 'req-00000202',
  })
  expect(rejected.status).toBe(200)
  expect(rejected.json['status']).toBe('rejected')
  expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('failed')

  // Rejected consent is not consumable, so the task cannot slip back to verified.
  const consumed = await post(f, '/api/approvals/consume', {
    id,
    digest: view['digest'],
    requestId: 'req-00000203',
  })
  expect(consumed.status).toBe(409)
  expect(f.runtime.ledger.task.getTask(task.taskId)?.status).toBe('failed')
})

test('a requestId replays the original approval after a ledger restart', async () => {
  const path = join(restartRoot, 'request-restart.db')
  const clock = { at: T0 }
  const first = fixture(path, clock)
  const body = {
    projectId: PROJECT_ID,
    kind: 'deploy',
    request: { a: 1 },
    requestId: 'req-00000301',
  }
  const created = await post(first, '/api/approvals/request', body)
  expect(created.status).toBe(201)
  expect(approvalCount(first)).toBe(1)
  first.runtime.close()

  const second = fixture(path, clock, false)
  try {
    const replay = await post(second, '/api/approvals/request', body)
    expectJson(replay, created)
    expect(approvalCount(second)).toBe(1)
  } finally {
    second.runtime.close()
  }
})

test('decide and consume requestIds replay after a restart without a second transition', async () => {
  const path = join(restartRoot, 'mutation-restart.db')
  const clock = { at: T0 }
  const first = fixture(path, clock)
  const task = seedClaimedTask(first)
  const created = await post(first, '/api/approvals/request', {
    projectId: PROJECT_ID,
    kind: 'task',
    request: { itemId: task.taskId, taskId: task.taskId, fence: task.fence },
    requestId: 'req-00000311',
  })
  const id = String(created.json['id'])
  const view = await challenge(first, id)

  const decideBody = {
    id,
    digest: view['digest'],
    nonce: view['nonce'],
    approve: true,
    requestId: 'req-00000312',
  }
  const decided = await post(first, '/api/approvals/decide', decideBody)
  expect(decided.status).toBe(200)

  const consumeBody = { id, digest: view['digest'], requestId: 'req-00000313' }
  const consumed = await post(first, '/api/approvals/consume', consumeBody)
  expect(consumed.status).toBe(200)
  expect(consumed.json['taskStatus']).toBe('verified')
  first.runtime.close()

  const second = fixture(path, clock, false)
  try {
    // Without the durable journal both replays would be 409 (already decided / already consumed).
    expectJson(await post(second, '/api/approvals/decide', decideBody), decided)
    expectJson(await post(second, '/api/approvals/consume', consumeBody), consumed)
    expect(second.runtime.ledger.task.getTask(task.taskId)?.status).toBe('verified')
  } finally {
    second.runtime.close()
  }
})
