import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOARD_COLUMNS, WORK_STATUSES, type TaskActionResult, type TaskCard, type TaskDetail, type TaskPage, type WorkStatus } from '../../shared/centralWork'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch, isCa2Path } from './ca2Routes'
import { freshDb, run, T0 } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { createRegistry } from './tools/toolRegistry'
import { createWorkStore } from './work/workStore'
import type { WorkStore } from './work/workModel'
import { registerWorkspaceLookup } from './workspaceLookup'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike // test-only
const BASE = '/api/central'
let dir: string
let h: Ca2Handle
let store: WorkStore
let clock = T0
let unregister: () => void = () => {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca2-work-'))
  clock = T0
  const registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({ runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => clock, env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_MODEL: 'paid' } })
  if (!booted) throw new Error('boot failed')
  h = booted
  store = createWorkStore(h.db, () => clock)
})
afterEach(() => { unregister(); unregister = () => {}; h.stop(); setActiveCa2(null); rmSync(dir, { recursive: true, force: true }) })

const call = (method: string, path: string, body: unknown = {}, actor?: string) => {
  const url = new URL(BASE + path, 'http://x')
  return ca2Dispatch(h, { method, path: url.pathname, query: url.searchParams, body: async () => body }, actor) as Promise<{ status: number; body: unknown }>
}
const page = async (q = '') => (await call('GET', `/tasks${q}`)).body as TaskPage
const post = async (path: string, body: unknown = {}) => { const r = await call('POST', path, body); return { status: r.status, body: r.body as TaskActionResult & { task: TaskCard; error: string } } }
const detail = async (id: string, q = '') => (await call('GET', `/tasks/${id}${q}`)).body as TaskDetail

let n = 0
function task(status: WorkStatus = 'todo', projectId = 'p1', title?: string): string {
  n += 1
  const id = `task-${n}`
  clock += 1
  store.createTask({ id, projectId, title: title ?? `title ${id}`, objective: 'o', actor: { kind: 'central' } })
  if (status !== 'todo') run(h.db, 'UPDATE central_task SET status = ? WHERE id = ?', status, id)
  return id
}
const assign = (status: WorkStatus, nodeId = 'n1', projectId = 'p1') => {
  const id = task('todo', projectId)
  const assignment = store.openAssignment({ taskId: id, nodeId, channel: 'chat', instruction: 'do it', actor: { kind: 'central' } })
  if (status !== 'assigned') run(h.db, 'UPDATE central_task SET status = ? WHERE id = ?', status, id)
  return { id, assignmentId: assignment.id }
}
const board = (nodes: unknown[]): void => { unregister(); unregister = registerWorkspaceLookup(() => null, () => [{ id: 'w1', name: 'One', nodes }]) }

describe('list', () => {
  it('owns its paths', () => {
    for (const p of ['/tasks', '/tasks/a', '/tasks/a/approve', '/tasks/a/changes', '/tasks/a/cancel', '/tasks/a/retry', '/work-settings']) expect(isCa2Path(BASE + p)).toBe(true)
    expect(isCa2Path(`${BASE}/tasks/a/other`)).toBe(false)
  })

  it('maps every status to its column', async () => {
    for (const status of WORK_STATUSES) task(status)
    for (const [column, statuses] of Object.entries(BOARD_COLUMNS)) {
      const { items } = await page(`?column=${column}`)
      expect(items.map((c) => c.status).sort()).toEqual([...statuses].sort())
      expect(new Set(items.map((c) => c.column))).toEqual(new Set([column]))
    }
  })

  it('filters by project, newest first, with paging and hasMore', async () => {
    const [a, b, c] = [task(), task(), task()]
    task('todo', 'p2')
    expect((await page('?projectId=p1')).items.map((x) => x.id)).toEqual([c, b, a])
    expect(await page('?projectId=p1&limit=2').then((p) => [p.items.length, p.hasMore])).toEqual([2, true])
    const last = await page('?projectId=p1&limit=2&offset=2')
    expect([last.items.map((x) => x.id), last.hasMore]).toEqual([[a], false])
  })

  it('answers 400 for a bad column or limit', async () => {
    for (const q of ['?column=nope', '?column=toString', '?limit=0', '?limit=201', '?limit=x', '?offset=-1']) expect((await call('GET', `/tasks${q}`)).status).toBe(400)
    expect((await call('GET', '/tasks?limit=200')).status).toBe(200)
  })

  it('answers with spawned agents off', async () => {
    expect(h.executor).toBeNull()
    task()
    expect((await page()).items).toHaveLength(1)
  })
})

describe('TaskCard', () => {
  it('carries project, node, last rule, unfinished blockers and verification', async () => {
    board([{ id: 'n1', name: 'Mango' }])
    const { id, assignmentId } = assign('needs_review')
    store.moveTask(id, 'cancelled', { actor: { kind: 'system' }, rule: 'r.one' })
    run(h.db, "UPDATE central_task SET status = 'needs_review' WHERE id = ?", id)
    store.setVerification(id, { passed: true })
    const [open, done] = [task('todo', 'p1', 'open blocker'), task('done')]
    run(h.db, 'INSERT INTO central_task_dep (task_id, blocked_by_id) VALUES (?, ?), (?, ?)', id, open, id, done)
    const card = (await detail(id)).task
    expect(card).toMatchObject({ projectName: 'One', column: 'needs_review', nodeName: 'Mango', nodeExists: true, lastRule: 'r.one', verification: { passed: true }, blockedBy: [{ id: open, title: 'open blocker' }] })
    expect(card.assignment?.id).toBe(assignmentId)
  })

  it('shows the open attempt, else the latest ended one', async () => {
    const { id, assignmentId } = assign('assigned')
    store.endAssignment(assignmentId, 'gone')
    expect((await detail(id)).task.assignment?.id).toBe(assignmentId)
    run(h.db, "UPDATE central_task SET status = 'todo' WHERE id = ?", id)
    const second = store.openAssignment({ taskId: id, nodeId: 'n2', channel: 'chat', instruction: 'again', actor: { kind: 'central' } })
    expect((await detail(id)).task.assignment?.id).toBe(second.id)
  })

  it('reports a node that no longer exists, and no node for an unassigned task', async () => {
    board([{ id: 'other', name: 'Kiwi' }])
    const { id } = assign('running', 'gone-node')
    expect((await detail(id)).task).toMatchObject({ nodeName: null, nodeExists: false })
    expect((await detail(task())).task).toMatchObject({ assignment: null, nodeName: null, nodeExists: false, lastRule: null, blockedBy: [] })
  })

  it('redacts secrets in what it sends', async () => {
    const id = task('todo', 'p1', 'key sk-abcdefghijklmnopqrstuvwx')
    store.setVerification(id, { token: 'hunter2hunter2' })
    const text = JSON.stringify((await detail(id)).task)
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(text).not.toContain('hunter2')
  })
})

describe('detail', () => {
  it('answers 404 for an unknown task', async () => {
    expect(await call('GET', '/tasks/nope')).toEqual({ status: 404, body: { error: 'task_not_found' } })
  })
  it('pages the timeline and lists attempts', async () => {
    const { id, assignmentId } = assign('running')
    const whole = await detail(id)
    expect(whole.assignments.map((a) => a.id)).toEqual([assignmentId])
    expect(whole.timeline.length).toBe(3)
    expect(whole.hasMoreTimeline).toBe(false)
    const first = await detail(id, '?limit=1')
    expect([first.timeline.map((e) => e.seq), first.hasMoreTimeline]).toEqual([[whole.timeline[0]?.seq], true])
    expect((await call('GET', `/tasks/${id}?limit=0`)).status).toBe(400)
  })
})

describe('actions', () => {
  const events = (id: string, kind: string) => store.timeline(id).filter((e) => e.kind === kind)

  it('approve moves needs_review to done, ends the attempt, one event by a human', async () => {
    const { id, assignmentId } = assign('needs_review')
    const r = await post(`/tasks/${id}/approve`)
    expect(r.status).toBe(200)
    expect(r.body.task).toMatchObject({ id, status: 'done', column: 'done' })
    expect(events(id, 'work.task.done').map((e) => e.actor)).toEqual(['human:root'])
    expect(store.getAssignment(assignmentId)?.endedAt).not.toBeNull()
  })

  it('changes sends it back with the note on the timeline', async () => {
    const { id, assignmentId } = assign('needs_review')
    const r = await post(`/tasks/${id}/changes`, { note: '  add a test ' })
    expect(r.body.task).toMatchObject({ status: 'todo', column: 'todo' })
    expect(r.body.task.assignment?.endReason).toBe('changes_requested')
    expect(store.getAssignment(assignmentId)?.endReason).toBe('changes_requested')
    expect((await detail(id)).timeline.filter((e) => e.kind === 'work.task.todo').at(-1)).toMatchObject({ reason: 'add a test', actor: 'human:root' })
  })

  it('changes needs a note of 1-2000 chars', async () => {
    const { id } = assign('needs_review')
    for (const note of [undefined, '', '   ', 1, 'x'.repeat(2001)]) expect(await post(`/tasks/${id}/changes`, { note }).then((r) => [r.status, r.body.error])).toEqual([400, 'invalid_note'])
    expect(store.getTask(id)?.status).toBe('needs_review')
  })

  it('cancel works from a live state, with or without a reason', async () => {
    const { id, assignmentId } = assign('running')
    const r = await post(`/tasks/${id}/cancel`, { reason: 'not needed' })
    expect(r.body.task.status).toBe('cancelled')
    expect(store.getAssignment(assignmentId)?.endReason).toBe('cancelled')
    expect(events(id, 'work.task.cancelled')[0]).toMatchObject({ reason: 'not needed', actor: 'human:root' })
    expect((await post(`/tasks/${task()}/cancel`)).body.task.status).toBe('cancelled')
    expect((await post(`/tasks/${task()}/cancel`, { reason: 5 })).status).toBe(400)
  })

  it('retry moves failed to todo and closes a leftover attempt', async () => {
    const { id, assignmentId } = assign('failed')
    expect((await post(`/tasks/${id}/retry`)).body.task.status).toBe('todo')
    expect(store.getAssignment(assignmentId)?.endReason).toBe('retried')
  })

  const refused: [string, WorkStatus, unknown][] = [
    ['approve', 'running', {}], ['approve', 'done', {}], ['approve', 'failed', {}],
    ['changes', 'running', { note: 'n' }], ['changes', 'failed', { note: 'n' }],
    ['retry', 'needs_review', {}], ['retry', 'assigned', {}], ['retry', 'todo', {}],
    ['cancel', 'done', {}], ['cancel', 'cancelled', {}],
  ]
  for (const [action, status, body] of refused) {
    it(`${action} from ${status} is 409`, async () => {
      const id = task(status)
      expect(await call('POST', `/tasks/${id}/${action}`, body)).toEqual({ status: 409, body: { error: 'illegal_transition' } })
      expect(store.getTask(id)?.status).toBe(status)
    })
  }

  it('unknown task is 404, wrong method 405', async () => {
    for (const a of ['approve', 'retry', 'cancel']) expect((await post(`/tasks/nope/${a}`)).status).toBe(404)
    expect((await call('GET', '/tasks/x/approve')).status).toBe(405)
    expect((await call('POST', '/tasks')).status).toBe(405)
    expect((await call('POST', '/tasks/x')).status).toBe(405)
  })

  it('refuses any actor that is not human', async () => {
    const id = task('needs_review')
    for (const a of ['approve', 'changes', 'cancel', 'retry']) expect(await call('POST', `/tasks/${id}/${a}`, { note: 'n' }, 'agent:a1')).toEqual({ status: 403, body: { error: 'human_only' } })
    expect((await call('POST', '/work-settings', { projectId: 'p1', autoDone: true }, 'agent:a1')).status).toBe(403)
    expect((await call('GET', '/work-settings?projectId=p1', {}, 'agent:a1')).status).toBe(403)
    expect(store.getTask(id)?.status).toBe('needs_review')
  })
})

describe('work settings', () => {
  const read = async (p: string) => (await call('GET', `/work-settings?projectId=${p}`)).body
  it('defaults off, sets per project', async () => {
    expect(await read('p1')).toEqual({ autoDone: false })
    expect((await call('POST', '/work-settings', { projectId: 'p1', autoDone: true })).body).toEqual({ projectId: 'p1', autoDone: true })
    expect(await read('p1')).toEqual({ autoDone: true })
    expect(await read('p2')).toEqual({ autoDone: false })
    await call('POST', '/work-settings', { projectId: 'p1', autoDone: false })
    expect(await read('p1')).toEqual({ autoDone: false })
  })
  it('validates', async () => {
    expect((await call('GET', '/work-settings')).status).toBe(400)
    expect((await call('GET', '/work-settings?projectId=nope')).status).toBe(404)
    expect((await call('POST', '/work-settings', { projectId: 'p1', autoDone: 'yes' })).status).toBe(400)
    expect((await call('POST', '/work-settings', { autoDone: true })).status).toBe(400)
    expect((await call('POST', '/work-settings', { projectId: 'nope', autoDone: true })).status).toBe(404)
    expect((await call('PUT', '/work-settings')).status).toBe(405)
  })
})
