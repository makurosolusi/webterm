// Bun-only (bun:sqlite): routines over the real ledger schema. Real shell prechecks, a real
// `agent.spawn` path with a FAKE `claude` binary (never the real CLI), the scheduler's catch-up
// collapse, event debounce + trust gate, budget caps, inbox items + events, and the UI-only HTTP seam.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshDb, rows, T0 } from '../central/guard/controlGuard.testutil'
import { startExec } from '../central/agents/execRunner'
import { createEventBus } from '../events/eventBus'
import type { AppendEventInput, SenseEvent } from '../events/eventModel'
import { createAgentSpawner, type AgentSpawnRequest, type AgentSpawnResult } from '../spawn/agentSpawn'
import { parseRoutineInput, type RoutineInput } from './routineModel'
import { runPrecheck } from './routinePrecheck'
import { createRoutineRunner, ROUTINE_EVENT, type FireResult } from './routineRunner'
import { createRoutineScheduler } from './routineScheduler'
import { createRoutineStore } from './routineStore'
import { handleRoutinesApi } from './routines.api'
import { createKeepAwake } from './routinesRuntime'

const HOUR = 3_600_000
const dir = mkdtempSync(join(tmpdir(), 'wt-routines-'))

/** Fake `claude -p ... --output-format json`: prints one result event, never calls a model. test-only */
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, '#!/bin/sh\necho \'{"type":"result","is_error":false,"result":"Found 2 untested files","total_cost_usd":0.5}\'\n')
chmodSync(fakeClaude, 0o755)

function input(over: Partial<Record<string, unknown>> = {}): RoutineInput {
  const r = parseRoutineInput({ name: 'Find tests', trigger: { type: 'api' }, action: { type: 'spawn', prompt: 'find missing tests' }, ...over })
  if (typeof r === 'string') throw new Error(r)
  return r
}

function setup(opts: { realSpawn?: boolean } = {}) {
  const db = freshDb()
  const clock = { t: T0 }
  const ctx = { db, now: () => clock.t }
  const store = createRoutineStore(ctx)
  const events: AppendEventInput[] = []
  const spawns: AgentSpawnRequest[] = []
  const queued: { to: string; body: string }[] = []
  const awake = { starts: 0, kills: 0 }
  const spawner = createAgentSpawner({
    ancestors: () => [], registerSpawn: () => {}, record: () => {}, onPtyExit: () => {},
    // Same argv shape agentSpawn builds, but the executable is the fake binary.
    exec: (spec) => startExec({ ...spec, argv: [fakeClaude, ...spec.argv.slice(1)] }),
  })
  const outcome = { exitCode: 0, timedOut: false, killed: false, lastEvent: { result: 'done', total_cost_usd: 0.1 }, tail: '' }
  const handle = { pid: 1, done: Promise.resolve(outcome), tail: () => '', kill: () => {} }
  const fakeSpawn = async (req: AgentSpawnRequest): Promise<AgentSpawnResult> => ({ ok: true, childId: 'node:headless-x', nodeId: 'headless-x', depth: 1, name: req.title ?? 'claude', handle })
  const runner = createRoutineRunner({
    ctx, store, cwdOf: (ws) => (ws === 'missing' ? null : dir), precheck: runPrecheck,
    record: (e) => { events.push(e) },
    enqueue: async (m) => { queued.push(m); return null },
    keepAwake: createKeepAwake(() => { awake.starts += 1; return { kill: () => { awake.kills += 1; return true } } as never }),
    spawn: async (req) => { spawns.push(req); return opts.realSpawn === false ? fakeSpawn(req) : spawner.spawn(req) },
  })
  const bus = createEventBus()
  const fired: FireResult[] = []
  const scheduler = createRoutineScheduler({ store, runner, bus, now: ctx.now, onFire: (f) => fired.push(f) })
  return { db, clock, ctx, store, runner, scheduler, bus, events, spawns, queued, awake, fired }
}

const ev = (kind: string, trust: 'trusted' | 'untrusted', nodeId: string | null = 'n1'): SenseEvent => ({
  seq: 1, ts: T0, kind, source: 'agentStatusApi', actor: 'node:n1', subject: null, workspaceId: null, nodeId, trust, dedupeKey: null, payload: null, prevHash: '', hash: '',
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let stops: Array<() => void> = []
afterEach(() => { for (const s of stops) s(); stops = [] })

test('a run spawns a headless agent (fake claude), records cost, creates an inbox review item and events', async () => {
  const s = setup()
  const r = s.store.create(input())
  const { run, done } = s.runner.fire(r, 'manual')
  expect(run.status).toBe('running')
  await done
  const [last] = s.store.runs(r.id)
  expect(last).toMatchObject({ status: 'ran', trigger: 'manual', costUsd: 0.5 })
  expect(last!.childId).toMatch(/^node:headless-/)
  expect(s.spawns[0]).toMatchObject({ mode: 'headless', parent: `routine:${r.id}`, cwd: dir, prompt: 'find missing tests' })
  const items = rows(s.db, 'SELECT kind, source, title, body FROM inbox_item WHERE id = ?', last!.inboxItemId)
  expect(items[0]).toMatchObject({ kind: 'review', source: 'routines', title: 'Routine "Find tests" finished', body: 'Found 2 untested files' })
  expect(s.events.map((e) => e.kind)).toEqual([ROUTINE_EVENT.run, ROUTINE_EVENT.finish])
  expect(JSON.stringify(s.events)).not.toContain('find missing tests') // Rule 12: no prompt in events
  expect(s.awake).toEqual({ starts: 1, kills: 1 }) // caffeinate held only while the run was active
})

test('precheck non-zero -> skipped with the exit code, no spawn (zero tokens)', async () => {
  const s = setup()
  const r = s.store.create(input({ precheck: { command: 'exit 3', timeoutSeconds: 5 } }))
  await s.runner.fire(r, 'manual').done
  expect(s.spawns).toHaveLength(0)
  expect(s.store.runs(r.id)[0]).toMatchObject({ status: 'skipped', reason: 'precheck exited 3' })
  expect(s.events.map((e) => e.kind)).toEqual([ROUTINE_EVENT.skip])
})

test('precheck timeout -> skipped; precheck exit 0 -> the agent runs', async () => {
  const s = setup()
  const slow = s.store.create(input({ precheck: { command: 'sleep 5', timeoutSeconds: 1 } }))
  await s.runner.fire(slow, 'manual').done
  expect(s.store.runs(slow.id)[0]).toMatchObject({ status: 'skipped', reason: 'precheck timed out after 1s' })
  const ok = s.store.create(input({ precheck: { command: 'test -d .', timeoutSeconds: 5 } }))
  await s.runner.fire(ok, 'manual').done
  expect(s.store.runs(ok.id)[0]!.status).toBe('ran')
  expect(s.spawns).toHaveLength(1)
})

test('catch-up: slots missed while asleep collapse into ONE catch_up run for the latest slot', async () => {
  const s = setup({ realSpawn: false })
  const r = s.store.create(input({ trigger: { type: 'schedule', cron: '0 * * * *' } }))
  s.store.setNextRun(r.id, T0 - 10 * HOUR) // laptop slept through 10 hourly slots, wakes 30 min after T0
  s.clock.t = T0 + HOUR / 2
  s.scheduler.tick()
  await Promise.all(s.fired.map((f) => f.done))
  const runs = s.store.runs(r.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ trigger: 'catch_up', status: 'ran', scheduledFor: T0 })
  expect(s.store.get(r.id)!.nextRunAt).toBe(T0 + HOUR)
  s.scheduler.tick() // nothing due any more
  expect(s.store.runs(r.id)).toHaveLength(1)
  // On time next hour = a plain schedule run.
  s.clock.t = T0 + HOUR + 1000
  s.scheduler.tick()
  expect(s.store.get(r.id)!.nextRunAt).toBe(T0 + 2 * HOUR)
  await Promise.all(s.fired.map((f) => f.done))
  expect(s.store.runs(r.id)[0]).toMatchObject({ trigger: 'schedule', status: 'ran' })
})

test('missed by more than 7 days -> one skipped row, no spawn', () => {
  const s = setup({ realSpawn: false })
  const r = s.store.create(input({ trigger: { type: 'schedule', cron: '0 9 1 1 *' } })) // yearly, Jan 1
  s.store.setNextRun(r.id, T0 - 300 * 24 * HOUR)
  s.scheduler.tick()
  expect(s.spawns).toHaveLength(0)
  expect(s.store.runs(r.id)[0]).toMatchObject({ status: 'skipped', trigger: 'catch_up' })
  expect(s.store.runs(r.id)[0]!.reason).toMatch(/^missed/)
})

test('event trigger: a burst fires once after the debounce; own routine events are ignored', async () => {
  const s = setup({ realSpawn: false })
  s.store.create(input({ trigger: { type: 'event', pattern: 'hook.*', debounceMs: 40 } }))
  s.scheduler.start()
  stops.push(s.scheduler.stop)
  for (let i = 0; i < 5; i += 1) s.bus.publish(ev('hook.Stop', 'trusted'))
  s.bus.publish({ ...ev('hook.Stop', 'trusted'), source: 'routines' })
  await sleep(100)
  await Promise.all(s.fired.map((f) => f.done))
  expect(s.fired).toHaveLength(1)
  expect(s.spawns).toHaveLength(1)
  expect(s.fired[0]!.run.trigger).toBe('event')
  s.bus.publish(ev('pty.exit', 'trusted')) // not matching
  await sleep(80)
  expect(s.fired).toHaveLength(1)
})

test('an untrusted event cannot fire an R2 (spawn) routine; it can fire an R1 (outbox) one', async () => {
  const s = setup({ realSpawn: false })
  const spawnR = s.store.create(input({ trigger: { type: 'event', pattern: 'browser.page', debounceMs: 20 } }))
  const outboxR = s.store.create(input({ name: 'Ping', trigger: { type: 'event', pattern: 'browser.page', debounceMs: 20 }, action: { type: 'outbox', to: 'n9', body: 'page changed' } }))
  s.scheduler.start()
  stops.push(s.scheduler.stop)
  s.bus.publish(ev('browser.page', 'untrusted'))
  await sleep(60)
  await Promise.all(s.fired.map((f) => f.done))
  expect(s.spawns).toHaveLength(0)
  expect(s.store.runs(spawnR.id)[0]).toMatchObject({ status: 'skipped', reason: 'untrusted event cannot fire a R2 routine' })
  expect(s.store.runs(outboxR.id)[0]).toMatchObject({ status: 'ran' })
  expect(s.queued[0]).toMatchObject({ to: 'n9', body: 'page changed', createdBy: `routine:${outboxR.id}` })
})

test('budget caps: runs per day and cost per day stop further runs', async () => {
  const s = setup()
  const byCount = s.store.create(input({ budget: { maxRunsPerDay: 1 } }))
  await s.runner.fire(byCount, 'manual').done
  await s.runner.fire(byCount, 'manual').done
  expect(s.store.runs(byCount.id)[0]).toMatchObject({ status: 'skipped', reason: 'budget: 1 runs in 24h (cap 1)' })
  const byCost = s.store.create(input({ budget: { maxRunsPerDay: 10, maxCostUsdPerDay: 0.5 } }))
  await s.runner.fire(byCost, 'manual').done // fake claude reports $0.50
  await s.runner.fire(byCost, 'manual').done
  expect(s.store.runs(byCost.id)[0]!.reason).toBe('budget: $0.50 spent in 24h (cap $0.5)')
  expect(s.spawns).toHaveLength(2)
  // A day later the budget is free again.
  s.clock.t = T0 + 25 * HOUR
  await s.runner.fire(byCount, 'manual').done
  expect(s.store.runs(byCount.id)[0]!.status).toBe('ran')
})

test('busy: a second fire while a run is active is skipped; unknown workspace is skipped', async () => {
  const s = setup()
  const r = s.store.create(input())
  const first = s.runner.fire(r, 'manual')
  const second = s.runner.fire(r, 'api')
  expect(second.run).toMatchObject({ status: 'skipped', reason: 'previous run still active' })
  await first.done
  const lost = s.store.create(input({ workspaceId: 'missing' }))
  expect(s.runner.fire(lost, 'manual').run).toMatchObject({ status: 'skipped', reason: 'workspace not found' })
})

const req = (method: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) => ({ method, headers } as unknown as IncomingMessage)
const url = (p: string) => new URL(`http://x${p}`)

test('HTTP: UI creates, lists, runs now; agents get 403; fire needs an api trigger', async () => {
  const s = setup({ realSpawn: false })
  const deps = { runtime: { store: s.store, runner: s.runner, scheduler: s.scheduler }, isNodeToken: (t: string) => t === 'node-tok' }
  const created = handleRoutinesApi(req('POST'), url('/api/routines'), { name: 'Nightly', trigger: { type: 'schedule', cron: '0 2 * * *' }, action: { type: 'spawn', prompt: 'p' } }, deps)
  expect(created.status).toBe(201)
  const id = (created.body as { routine: { id: string } }).routine.id
  const list = handleRoutinesApi(req('GET'), url('/api/routines'), undefined, deps).body as { routines: { tier: string }[]; templates: unknown[] }
  expect(list.routines[0]!.tier).toBe('R2')
  expect(list.templates.length).toBeGreaterThan(0)
  expect(handleRoutinesApi(req('POST'), url('/api/routines'), { name: 'x', trigger: { type: 'schedule', cron: 'bad' }, action: { type: 'spawn', prompt: 'p' } }, deps).status).toBe(400)
  // Agent credential: refused everywhere, fire included.
  expect(handleRoutinesApi(req('GET', { 'x-webterm-token': 'node-tok' }), url('/api/routines'), undefined, deps).status).toBe(403)
  expect(handleRoutinesApi(req('POST', { 'x-webterm-token': 'node-tok' }), url(`/api/routines/${id}/fire`), {}, deps).status).toBe(403)
  // curl with the root token (no browser metadata): may fire, may not manage.
  expect(handleRoutinesApi(req('POST', {}), url(`/api/routines/${id}/run`), {}, deps).status).toBe(403)
  expect(handleRoutinesApi(req('POST', {}), url(`/api/routines/${id}/fire`), {}, deps)).toMatchObject({ status: 409, body: { error: 'routine_has_no_api_trigger' } })
  const run = handleRoutinesApi(req('POST'), url(`/api/routines/${id}/run`), {}, deps)
  expect(run.status).toBe(202)
  await Promise.all(s.fired.map((f) => f.done))
  await sleep(10)
  const runs = handleRoutinesApi(req('GET'), url(`/api/routines/${id}/runs?limit=5`), undefined, deps).body as { runs: { trigger: string }[] }
  expect(runs.runs[0]!.trigger).toBe('manual')
  const api = handleRoutinesApi(req('PUT'), url(`/api/routines/${id}`), { name: 'Nightly', trigger: { type: 'api' }, action: { type: 'spawn', prompt: 'p' } }, deps)
  expect(api.status).toBe(200)
  expect(handleRoutinesApi(req('POST', {}), url(`/api/routines/${id}/fire`), {}, deps).status).toBe(202)
  expect(handleRoutinesApi(req('DELETE'), url(`/api/routines/${id}`), undefined, deps).status).toBe(200)
  expect(rows(s.db, 'SELECT COUNT(*) AS n FROM routine_run')[0]!['n']).toBe(0) // history cascades
})

test('orphaned running rows from a crash are failed at scheduler start', () => {
  const s = setup({ realSpawn: false })
  const r = s.store.create(input())
  s.store.addRun({ routineId: r.id, trigger: 'manual', status: 'running' })
  s.scheduler.start()
  stops.push(s.scheduler.stop)
  expect(s.store.runs(r.id)[0]).toMatchObject({ status: 'failed', reason: 'interrupted' })
})
