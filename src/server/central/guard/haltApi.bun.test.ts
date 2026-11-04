// Bun-only. Halt is root-only and persistent; control endpoints enforce human-only raising.
import { expect, test } from 'bun:test'
import { controlRoute, CONTROL_PATH, HALT_PATH, type ControlRequest } from './haltApi'
import { createControlGuard } from './controlGuard'
import { readLevel } from './levelStore'
import { eventKinds, freshDb, HUMAN, ROOT, T0 } from './controlGuard.testutil'

const now = () => T0
const AUTO = { WEBTERM_CENTRAL_AGENTS: 'auto' }
const call = (db: ReturnType<typeof freshDb>, r: Partial<ControlRequest> & Pick<ControlRequest, 'method' | 'path'>, extra: { onHalt?: () => void } = {}) =>
  controlRoute({ actor: null, ...r }, { db, now, env: AUTO, ...extra })

test('halt is root only: no actor 401, human/central 403, state untouched', async () => {
  const db = freshDb()
  const denied = [null, HUMAN, { kind: 'central', id: 'c' } as const]
  const statuses: number[] = []
  for (const actor of denied) statuses.push((await call(db, { method: 'POST', path: HALT_PATH, actor }))?.status ?? 0)
  expect(statuses.join(',')).toBe('401,403,403')
  expect(readLevel(db, 'global')).toBe(null)
})

test('root halt sets global off, runs the hook, audits, and is idempotent; the guard then answers halted', async () => {
  const db = freshDb()
  const reasons: string[] = []
  const onHalt = (info: { reason: string }) => { reasons.push(info.reason) }
  const first = await controlRoute({ method: 'POST', path: HALT_PATH, actor: ROOT, body: { reason: 'runaway' } }, { db, now, env: AUTO, onHalt })
  expect(first?.status).toBe(200)
  expect(readLevel(db, 'global')?.level).toBe('off')
  const second = await controlRoute({ method: 'POST', path: HALT_PATH, actor: ROOT }, { db, now, env: AUTO, onHalt })
  expect(second?.status).toBe(200)
  expect(reasons.join('|')).toBe('runaway|kill-switch')
  expect(eventKinds(db, 'central.halt').length).toBe(2)
  const guard = createControlGuard({ db, now, env: AUTO })
  const d = guard.check({ action: 'tool', projectId: null, tool: 'goal.propose', tier: 'R1' })
  expect(d.verdict === 'deny' ? d.code : d.verdict).toBe('halted')
})

test('a failing halt hook still leaves the level off and reports 500 halted', async () => {
  const db = freshDb()
  const res = await controlRoute({ method: 'POST', path: HALT_PATH, actor: ROOT }, { db, now, env: AUTO, onHalt: () => { throw new Error('close failed') } })
  expect(res?.status).toBe(500)
  expect(JSON.stringify(res?.body)).toContain('"halted":true')
  expect(JSON.stringify(res?.body)).toContain('close failed')
  expect(readLevel(db, 'global')?.level).toBe('off')
})

test('PUT control: raise needs a human, central is refused, lowering works, CAS and validation are typed', async () => {
  const db = freshDb()
  const put = (actor: ControlRequest['actor'], body: unknown) => call(db, { method: 'PUT', path: CONTROL_PATH, actor, body })
  const central = { kind: 'central', id: 'c' } as const
  expect((await put(central, { scope: 'global', level: 'act_envelope' }))?.status).toBe(403)
  expect((await put(null, { scope: 'global', level: 'act_envelope' }))?.status).toBe(401)
  expect((await put(HUMAN, { scope: 'global', level: 'godmode' }))?.status).toBe(400)
  expect((await put(HUMAN, { scope: 'nope', level: 'off' }))?.status).toBe(400)
  const up = await put(HUMAN, { scope: 'global', level: 'act_gated', reason: 'ok' })
  expect(up?.status).toBe(200)
  expect((await put(HUMAN, { scope: 'global', level: 'off', expectedVersion: 0 }))?.status).toBe(409)
  expect((await put(HUMAN, { scope: 'project:p1', level: 'observe', expectedVersion: 0 }))?.status).toBe(200)
  expect((await put(central, { scope: 'project:p1', level: 'off' }))?.status).toBe(403)
  expect(readLevel(db, 'project:p1')?.level).toBe('observe')
})

test('GET control is human/root only, shows effective level, paginates and validates', async () => {
  const db = freshDb()
  await call(db, { method: 'PUT', path: CONTROL_PATH, actor: HUMAN, body: { scope: 'project:p1', level: 'observe' } })
  await call(db, { method: 'PUT', path: CONTROL_PATH, actor: HUMAN, body: { scope: 'project:p2', level: 'off' } })
  expect((await call(db, { method: 'GET', path: CONTROL_PATH }))?.status).toBe(401)
  expect((await call(db, { method: 'GET', path: CONTROL_PATH, actor: { kind: 'worker', id: 'w' } }))?.status).toBe(403)
  const page = await call(db, { method: 'GET', path: CONTROL_PATH, actor: HUMAN, query: new URLSearchParams('limit=1') })
  const body = page?.body as { projects: { scope: string }[]; effective: string; ceiling: string; global: { level: string; version: number } }
  expect(body.projects.length).toBe(1)
  expect(body.projects[0]?.scope).toBe('project:p1')
  expect(body.ceiling).toBe('act_envelope')
  expect(body.effective).toBe('act_gated') // no global row: inherits the ceiling, capped at act_gated
  expect(body.global).toMatchObject({ level: 'act_gated', version: 0 }) // shown level = the one in force, not the stored default
  const one = await call(db, { method: 'GET', path: CONTROL_PATH, actor: ROOT, query: new URLSearchParams('projectId=p1') })
  expect((one?.body as { effective: string }).effective).toBe('observe')
  expect((await call(db, { method: 'GET', path: CONTROL_PATH, actor: HUMAN, query: new URLSearchParams('limit=0') }))?.status).toBe(400)
  expect(await call(db, { method: 'GET', path: '/api/other' })).toBe(null)
})
