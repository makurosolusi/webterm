// Routines while Claude is unreachable: due slots are held (not fired, not "missed") and caught up ONCE after
// recovery; a run killed by a transient failure is retried ONCE; auth/permanent failures never are.
import { expect, test } from 'bun:test'
import { freshDb, rows, T0 } from '../central/guard/controlGuard.testutil'
import { createEventBus } from '../events/eventBus'
import type { AgentSpawnRequest, AgentSpawnResult } from '../spawn/agentSpawn'
import { parseRoutineInput } from './routineModel'
import { createRoutineRunner, type FireResult } from './routineRunner'
import { createRoutineScheduler, RETRY_DELAY_MS, ROUTINE_TICK_MS } from './routineScheduler'
import { createRoutineStore } from './routineStore'

const HOUR = 3_600_000
const GRACE = 60_000 // workHold RECOVERY_GRACE_MS (one boot-grace minute)

type Note = { delayed: number; retried: number; reason: string }

function setup(withPort = true) {
  const db = freshDb()
  const clock = { t: T0 }
  const ctx = { db, now: () => clock.t }
  const store = createRoutineStore(ctx)
  const net = { impaired: false }
  const port = { isImpaired: () => net.impaired, state: () => ({ state: 'offline' as const, since: T0, cause: 'dns' as const, lastOkAt: null, consecutiveFailures: 3, consecutiveSuccesses: 0 }) }
  const outcomes: { exitCode: number; text: string }[] = []
  const spawns: AgentSpawnRequest[] = []
  const spawn = async (req: AgentSpawnRequest): Promise<AgentSpawnResult> => {
    spawns.push(req)
    const o = outcomes.shift() ?? { exitCode: 0, text: 'done' }
    const outcome = { exitCode: o.exitCode, timedOut: false, killed: false, lastEvent: { result: o.text, is_error: o.exitCode !== 0 }, tail: o.text }
    return { ok: true, childId: 'node:h', nodeId: 'h', depth: 1, name: 'c', handle: { pid: 1, done: Promise.resolve(outcome), tail: () => '', kill: () => {} } } as never
  }
  const runner = createRoutineRunner({
    ctx, store, cwdOf: () => '/tmp', precheck: async () => ({ exitCode: 0, timedOut: false, output: '' }) as never, record: () => {},
    enqueue: async () => null, keepAwake: { acquire() {}, release() {} }, spawn,
    ...(withPort ? { connectivity: () => port } : {}),
  })
  const notes: Note[] = []
  const fired: FireResult[] = []
  const scheduler = createRoutineScheduler({
    store, runner, bus: createEventBus(), now: ctx.now, onFire: (f) => fired.push(f),
    ...(withPort ? { connectivity: () => port, note: (i: Note) => notes.push(i) } : {}),
  })
  const settle = (): Promise<unknown> => Promise.all(fired.map((f) => f.done))
  const make = (trigger: Record<string, unknown>, name: string) => {
    const input = parseRoutineInput({ name, trigger, action: { type: 'spawn', prompt: 'p' } })
    if (typeof input === 'string') throw new Error(input)
    return store.create(input)
  }
  const hourly = (name = 'r') => {
    const r = make({ type: 'schedule', cron: '0 * * * *' }, name)
    store.setNextRun(r.id, T0)
    return r
  }
  const api = (name = 'a') => make({ type: 'api' }, name)
  const inbox = (): number => rows(db, 'SELECT * FROM inbox_item').length
  return { clock, store, net, outcomes, spawns, runner, scheduler, notes, settle, hourly, api, inbox }
}

test('impaired: nothing fires and nothing is marked missed; after recovery + grace exactly ONE catch_up per routine', async () => {
  const s = setup()
  const a = s.hourly('a')
  const b = s.hourly('b')
  s.net.impaired = true
  s.clock.t = T0 + 5 * HOUR // five hourly slots passed during the outage
  s.scheduler.tick()
  s.clock.t += ROUTINE_TICK_MS
  s.scheduler.tick()
  expect(s.spawns).toHaveLength(0)
  expect(s.store.runs(a.id)).toHaveLength(0)
  expect(s.store.get(a.id)!.nextRunAt).toBe(T0) // slot untouched
  s.net.impaired = false
  s.clock.t += ROUTINE_TICK_MS
  s.scheduler.tick() // recovery seen: grace starts
  expect(s.spawns).toHaveLength(0)
  s.clock.t += GRACE
  s.scheduler.tick()
  s.scheduler.tick()
  await s.settle()
  expect(s.spawns).toHaveLength(2)
  for (const r of [a, b]) {
    const runs = s.store.runs(r.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ trigger: 'catch_up', status: 'ran' })
  }
  expect(s.notes).toEqual([{ delayed: 2, retried: 0, reason: 'offline:dns' }])
})

test('a hold episode with no routine affected leaves no note', () => {
  const s = setup()
  s.net.impaired = true
  s.scheduler.tick()
  s.net.impaired = false
  s.scheduler.tick()
  s.clock.t += GRACE
  s.scheduler.tick()
  expect(s.notes).toEqual([])
  expect(s.inbox()).toBe(0)
})

test('a transient failure is retried ONCE: success ends it, a second failure is final and never loops', async () => {
  const s = setup()
  const r = s.api()
  s.outcomes.push({ exitCode: 1, text: 'fetch failed: ECONNRESET' }, { exitCode: 0, text: 'ok' })
  await s.runner.fire(r, 'api').done
  expect(s.store.runs(r.id)[0]).toMatchObject({ status: 'failed' })
  expect(s.store.runs(r.id)[0]!.reason).toMatch(/^retryable\[network\]/)
  expect(s.inbox()).toBe(0) // not announced as failed while a retry is pending
  s.scheduler.tick()
  expect(s.spawns).toHaveLength(1) // too early
  s.clock.t += RETRY_DELAY_MS
  s.scheduler.tick()
  await s.settle()
  expect(s.spawns).toHaveLength(2)
  expect(s.store.runs(r.id)[0]).toMatchObject({ trigger: 'catch_up', status: 'ran' })
  expect(s.store.runs(r.id)[1]!.reason).toMatch(/^retried\[network\]/)

  s.outcomes.push({ exitCode: 1, text: '529 overloaded' }, { exitCode: 1, text: '529 overloaded' })
  s.clock.t += 1000
  await s.runner.fire(r, 'api').done
  s.clock.t += RETRY_DELAY_MS
  s.scheduler.tick()
  await s.settle()
  expect(s.store.runs(r.id)[0]).toMatchObject({ status: 'failed' })
  expect(s.store.runs(r.id)[0]!.reason).not.toMatch(/^retry/)
  expect(s.inbox()).toBe(2) // the first retry's review item + this final failure; never a notice for a failure that was retried
  for (let i = 0; i < 3; i++) { s.clock.t += RETRY_DELAY_MS; s.scheduler.tick() }
  await s.settle()
  expect(s.spawns).toHaveLength(4)
})

test('auth and permanent failures are never retried', async () => {
  const s = setup()
  const r = s.api()
  s.outcomes.push({ exitCode: 1, text: 'Invalid API key' }, { exitCode: 1, text: 'credit balance is too low' })
  await s.runner.fire(r, 'api').done
  s.clock.t += 1000
  await s.runner.fire(r, 'api').done
  expect(s.store.runs(r.id).map((x) => x.reason?.startsWith('retry'))).toEqual([false, false])
  s.clock.t += RETRY_DELAY_MS
  s.scheduler.tick()
  expect(s.spawns).toHaveLength(2)
  expect(s.inbox()).toBe(2)
})

test('boot: a run interrupted during an outage is interrupted_network and retried once; without an episode the old failure stays', async () => {
  const s = setup()
  const r = s.api('r')
  const q = s.api('q')
  s.store.addRun({ routineId: r.id, trigger: 'api', status: 'running' })
  s.store.addRun({ routineId: q.id, trigger: 'api', status: 'running' })
  s.clock.t += 1000
  expect(s.store.failOrphans([{ startedAt: T0 - 1000, endedAt: null }])).toBe(2)
  expect(s.store.runs(r.id)[0]!.reason).toBe('retryable[network]: interrupted_network')
  s.clock.t += RETRY_DELAY_MS
  s.scheduler.tick()
  s.scheduler.tick()
  await s.settle()
  expect(s.spawns).toHaveLength(2) // one retry per routine, never twice
  const s2 = setup()
  const z = s2.api()
  s2.store.addRun({ routineId: z.id, trigger: 'api', status: 'running' })
  s2.store.failOrphans([{ startedAt: T0 - 9 * HOUR, endedAt: T0 - 8 * HOUR }]) // an old, closed episode
  expect(s2.store.runs(z.id)[0]).toMatchObject({ status: 'failed', reason: 'interrupted' })
  s2.clock.t += RETRY_DELAY_MS
  s2.scheduler.tick()
  expect(s2.spawns).toHaveLength(0)
})

test('without a connectivity port a transient failure is final at once (old behaviour)', async () => {
  const s = setup(false)
  const r = s.api()
  s.outcomes.push({ exitCode: 1, text: 'fetch failed: ECONNRESET' })
  await s.runner.fire(r, 'api').done
  expect(s.store.runs(r.id)[0]!.reason).toBe('agent exited 1')
  expect(s.inbox()).toBe(1)
})
