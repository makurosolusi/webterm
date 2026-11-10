import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GoalCard, GoalPage, TaskPage } from '../../shared/centralWork'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import type { SessionsLike } from '../orchestrator/workerRuntimeSession'
import { type Ca2Handle, bootCa2, setActiveCa2 } from './ca2Boot'
import { ca2Dispatch, isCa2Path } from './ca2Routes'
import { getGoal, proposeGoal } from './goalStore'
import { freshDb, run, T0 } from './guard/controlGuard.testutil'
import { CORE_DEFS } from './tools/defs/core.defs'
import { ALLOW_ALL_GUARD, execTool } from './tools/toolExec'
import { createRegistry } from './tools/toolRegistry'

const sessions = { open() {}, input() {}, statusOf: () => undefined, getTerminal: () => '', isLive: () => false, close() {} } as unknown as SessionsLike // test-only
const BASE = '/api/central'
const draft = { statement: 'Ship login', successCriteria: [{ kind: 'review', by: 'human' }], owner: 'human:a', horizon: '2030-01-02', envelope: { maxCostMicros: 1, maxWallMs: 1, maxItems: 1 } } // test-only
const central = { id: 'central', kind: 'central' }
let dir: string
let h: Ca2Handle
let registry: ReturnType<typeof createRegistry>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca2-goals-'))
  registry = createRegistry()
  for (const d of CORE_DEFS) registry.register(d)
  const booted = bootCa2({ runtime: { db: freshDb() } as unknown as LedgerRuntime, sessions, registry, noTimer: true, dataDirPath: dir, now: () => T0, env: { WEBTERM_CENTRAL: 'on', WEBTERM_CENTRAL_RUNTIME: 'mock' } })
  if (!booted) throw new Error('boot failed')
  h = booted
})
afterEach(() => { h.stop(); setActiveCa2(null); rmSync(dir, { recursive: true, force: true }) })

const call = (method: string, path: string, body: unknown = {}, actor?: string) => {
  const url = new URL(BASE + path, 'http://x')
  return ca2Dispatch(h, { method, path: url.pathname, query: url.searchParams, body: async () => body }, actor) as Promise<{ status: number; body: unknown }>
}
const list = async (q = '') => (await call('GET', `/goals${q}`)).body as GoalPage
const propose = (projectId = 'p1') => proposeGoal(h.db, { projectId, draft, actor: central })
const plan = async (items: unknown[], projectId = 'p1') => {
  const ctx = { db: h.db, registry, guard: ALLOW_ALL_GUARD, maxTier: 'R3' as const, conversationId: 'central:global', now: () => T0 }
  return (await execTool(ctx, 'plan.propose', { projectId, items })).data?.taskIds as string[]
}
const setStatus = (id: string, status: string) => run(h.db, 'UPDATE central_task SET status = ? WHERE id = ?', status, id)

describe('GET /goals', () => {
  it('owns its paths only', () => {
    for (const p of ['/goals', '/goals/p1/activate', '/goals/p1/abandon']) expect(isCa2Path(BASE + p)).toBe(true)
    expect(isCa2Path(`${BASE}/goals/p1`)).toBe(false)
    expect(isCa2Path(`${BASE}/goals/p1/achieve`)).toBe(false)
  })

  it('returns only projects with a goal, as GoalCards with counts', async () => {
    expect(await list()).toEqual({ items: [], hasMore: false })
    propose()
    const [a, b] = await plan([{ title: 'a' }, { title: 'b' }, { title: 'c' }])
    setStatus(a as string, 'running')
    setStatus(b as string, 'needs_review')
    const { name } = h.db.query(`SELECT name FROM project WHERE id = 'p1'`).get() as { name: string }
    expect(await list()).toEqual({
      items: [{ projectId: 'p1', projectName: name, version: 1, statement: 'Ship login', status: 'proposed', horizon: '2030-01-02', counts: { todo: 1, in_progress: 1, needs_review: 1, done: 0 }, total: 3, complete: false }],
      hasMore: false,
    })
  })

  it('pages, filters by project and refuses a bad page', async () => {
    propose('p1')
    propose('p2')
    expect(await list('?limit=1').then((p) => [p.items.length, p.hasMore])).toEqual([1, true])
    expect(await list('?limit=1&offset=1').then((p) => [p.items.length, p.hasMore])).toEqual([1, false])
    expect((await list('?projectId=p2')).items.map((c) => c.projectId)).toEqual(['p2'])
    expect((await call('GET', '/goals?limit=0')).status).toBe(400)
  })

  it('leaves a corrupt goal off the page instead of failing it', async () => {
    propose('p1')
    run(h.db, `UPDATE project SET goal_json = '{"broken":true}' WHERE id = 'p2'`)
    expect((await list()).items.map((c) => c.projectId)).toEqual(['p1'])
  })

  it('reports complete once every linked task is finished, and the goal stays as it was', async () => {
    propose()
    const ids = await plan([{ title: 'a' }, { title: 'b' }])
    setStatus(ids[0] as string, 'done')
    expect((await list()).items[0]?.complete).toBe(false)
    setStatus(ids[1] as string, 'done')
    expect((await list()).items[0]).toMatchObject({ complete: true, status: 'proposed' })
    expect(getGoal(h.db, 'p1')?.status).toBe('proposed')
  })
})

describe('POST /goals/:projectId/*', () => {
  const post = async (path: string, body: unknown, actor?: string) => { const r = await call('POST', path, body, actor); return { status: r.status, body: r.body as { goal: GoalCard; error: string } } }

  it('activates and abandons, carrying the linked tasks to the new version', async () => {
    propose()
    await plan([{ title: 'a' }])
    const activated = await post('/goals/p1/activate', { version: 1 })
    expect(activated.status).toBe(200)
    expect(activated.body.goal).toMatchObject({ projectId: 'p1', version: 2, status: 'active', total: 1, counts: { todo: 1 } })
    const abandoned = await post('/goals/p1/abandon', { version: 2 })
    expect(abandoned.body.goal).toMatchObject({ version: 3, status: 'abandoned', total: 1 })
  })

  it('answers 409 stale_version for an old version or a project without a goal', async () => {
    propose()
    expect(await post('/goals/p1/activate', { version: 5 })).toMatchObject({ status: 409, body: { error: 'stale_version' } })
    expect(await post('/goals/p2/activate', { version: 1 })).toMatchObject({ status: 409, body: { error: 'stale_version' } })
  })

  it('answers 409 for an illegal move, 400 for a bad version or reason, 404 for an unknown project', async () => {
    propose()
    expect(await post('/goals/p1/abandon', { version: 1 })).toMatchObject({ status: 409, body: { error: 'illegal_transition' } })
    expect(await post('/goals/p1/activate', {})).toMatchObject({ status: 400, body: { error: 'invalid_version' } })
    await post('/goals/p1/activate', { version: 1 })
    expect(await post('/goals/p1/abandon', { version: 2, reason: 7 })).toMatchObject({ status: 400, body: { error: 'invalid_goal' } })
    expect(await post('/goals/nope/activate', { version: 1 })).toMatchObject({ status: 404, body: { error: 'project_not_found' } })
  })

  it('is human-only: a non-human actor changes nothing', async () => {
    propose()
    expect(await post('/goals/p1/activate', { version: 1 }, 'central')).toMatchObject({ status: 403, body: { error: 'human_only' } })
    expect(getGoal(h.db, 'p1')?.status).toBe('proposed')
    expect((await call('GET', '/goals', {}, 'central')).status).toBe(200)
  })

  it('answers 405 for the wrong method', async () => {
    expect((await call('DELETE', '/goals')).status).toBe(405)
    expect((await call('GET', '/goals/p1/activate')).status).toBe(405)
  })
})

describe('task board', () => {
  it('cards carry the goal link and the todo column follows the plan', async () => {
    propose()
    const ids = await plan([{ title: 'first' }, { title: 'second' }, { title: 'third' }])
    run(h.db, 'UPDATE central_task SET updated_at = ? WHERE id = ?', T0 + 9, ids[0] as string) // newest change, still first in the plan
    run(h.db, 'UPDATE central_task SET updated_at = ? WHERE id = ?', T0 + 5, ids[2] as string)
    const { items } = (await call('GET', '/tasks?column=todo')).body as TaskPage
    expect(items.map((c) => [c.title, c.seq, c.goalVersion])).toEqual([['first', 1, 1], ['second', 2, 1], ['third', 3, 1]])
  })
})
