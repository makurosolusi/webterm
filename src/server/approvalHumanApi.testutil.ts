// Shared fixture for the approvalHumanApi*.test.ts files: a REAL ledger (in-memory SQLite) driven
// through the HTTP seam as the signed-in webterm page.
import { TEST_UI_COOKIE } from './uiSession.testutil'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { approvalHumanRoute, type HumanApprovalDeps } from './approvalHumanApi'
import { memoryLedgerRuntime, seedProject, seedReviewTask } from './approvalTestRuntime.testutil'

const REQ ='req-00000001'
/** The signed-in webterm page: the only caller the UI-only policy admits. */
const BROWSER = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }

interface FakeRes {
  statusCode: number
  payload: string
  headers: Record<string, string>
  setHeader(name: string, value: string): void
  end(data?: string): void
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200, payload: '', headers: {},
    setHeader(name: string, value: string) { this.headers[name] = value },
    end(data = '') { this.payload = data },
  }
}

type CallInit = { method?: string; body?: string | Buffer; headers?: Record<string, string> }

async function call(deps: HumanApprovalDeps, path: string, init: CallInit = {}): Promise<{ handled: boolean; status: number; json: Record<string, unknown> }> {
  const chunks = init.body === undefined ? [] : [Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body)]
  const req = Readable.from(chunks) as unknown as IncomingMessage
  req.method = init.method ?? (init.body === undefined ? 'GET' : 'POST')
  req.headers = { ...BROWSER, ...init.headers }
  const res = fakeRes()
  const handled = await approvalHumanRoute(req, res as unknown as ServerResponse, new URL(path, 'http://x'), deps)
  return { handled, status: res.statusCode, json: res.payload === '' ? {} : (JSON.parse(res.payload) as Record<string, unknown>) }
}

/** A fresh ledger with project `p1`, plus helpers that call the human approval route. */
export function setup(opts: { ledger?: boolean } = {}) {
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

export type Fixture = ReturnType<typeof setup>

/** The challenge view (digest + nonce) for approval `id`. */
export async function challenge(f: Fixture, id: string) {
  const res = await f.call(f.deps, `/api/approvals/challenge?id=${id}`)
  return res.json
}

/** POST /api/approvals/decide with a fixed requestId unless `extra` overrides it. */
export async function decide(
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

/** A freshly requested approval that has already been approved. */
export async function approvedApproval(f: Fixture): Promise<{ id: string; digest: string }> {
  const created = await f.request({})
  const view = await challenge(f, String(created.json['id']))
  await decide(f, String(created.json['id']), view['digest'], view['nonce'])
  return { id: String(created.json['id']), digest: String(view['digest']) }
}

export const TOKEN = 'root-secret' // test-only
export const TOKEN_HEADERS = { 'x-webterm-token': TOKEN }

/** Task-event actors in write order, read straight from the audit table. */
export function eventActors(f: Fixture, taskId: string): string[] {
  const db = f.runtime.db as unknown as {
    query(sql: string): { all(id: string): Array<{ actor: string }> }
  }
  return db.query('SELECT actor FROM event WHERE task_id = ? ORDER BY seq').all(taskId).map((r) => r.actor)
}

/** A claimed_done task plus the pending task approval a human decides on. */
export async function taskApprovalFor(f: Fixture) {
  const task = seedReviewTask(f.runtime)
  const body = { kind: 'task', taskId: task.taskId, fence: task.fence, request: { itemId: task.taskId } }
  const id = String((await f.request(body)).json['id'])
  return { task, id, view: await challenge(f, id) }
}
