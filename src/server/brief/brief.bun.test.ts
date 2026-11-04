// Bun-only (bun:sqlite): the brief read from a real ledger (events + Inbox + usage), the visit
// window, the cache/precompute, dismiss persistence and the HTTP route.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedgerDb } from '../ledger/migration'
import { createLedger } from '../ledger/ledger'
import { createEventLog } from '../events/eventLog'
import { createEventBus } from '../events/eventBus'
import { isNodeTokenPath } from '../auth'
import { headSeq, readBriefSource } from './brief.source'
import { AWAY_GAP_MS, FIRST_WINDOW_MS, PRECOMPUTE_DEBOUNCE_MS, createBriefService, type BriefServiceDeps } from './brief.service'
import { BRIEF_DISMISS_PATH, BRIEF_PATH, briefRoute, workspaceLabels } from './brief.route'

const T0 = 1_700_000_000_000
const DIR = mkdtempSync(join(tmpdir(), 'webterm-brief-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))
let n = 0
const statePath = (): string => join(DIR, `state-${++n}.json`)

function fixture() {
  const db = openLedgerDb(':memory:')
  const bus = createEventBus()
  const clock = { t: T0 }
  const log = createEventLog(db, { bus, now: () => clock.t })
  const ledger = createLedger(db, { now: T0 })
  return { db, bus, clock, log, ledger }
}

function service(f: ReturnType<typeof fixture>, extra: Partial<BriefServiceDeps> = {}) {
  let reads = 0
  const svc = createBriefService({
    statePath: statePath(),
    now: () => f.clock.t,
    read: (since, now) => { reads += 1; return readBriefSource(f.db, since, now) },
    headSeq: () => headSeq(f.db),
    nodeLabel: (id) => `node ${id}`,
    workspaceLabel: (id) => `ws ${id}`,
    ...extra,
  })
  return { svc, reads: () => reads }
}

test('only events since the last active time are briefed; Inbox and usage are read from the ledger', () => {
  const f = fixture()
  const { svc } = service(f)
  f.clock.t = T0
  svc.get() // first visit ever: window = last 24h
  expect(svc.state()).toMatchObject({ visitSince: T0 - FIRST_WINDOW_MS, visitStartedAt: T0, lastActiveAt: T0 })

  f.clock.t = T0 + 1000
  f.log.append({ kind: 'hook.Stop', source: 'test', nodeId: 'old', trust: 'trusted', payload: { status: 'done' } })
  f.clock.t = T0 + 5 * 60_000
  svc.touch(f.clock.t) // still active (presence): user saw that one

  // Overnight: user away, agents keep working.
  const night = T0 + 5 * 60_000 + AWAY_GAP_MS + 1
  f.clock.t = night
  f.log.append({ kind: 'hook.Stop', source: 'test', nodeId: 'a', trust: 'trusted', payload: { status: 'done' } })
  f.log.append({ kind: 'pty.exit', source: 'pty', nodeId: 't', trust: 'trusted', payload: { code: 1, reason: 'self' } })
  f.log.append({ kind: 'agent.restored', source: 'pty', nodeId: 'a', trust: 'trusted', payload: { agentId: 'claude' } })
  f.log.append({ kind: 'checkpoint.created', source: 'checkpoint', workspaceId: 'w1', trust: 'trusted', payload: { seq: 1 } })
  f.ledger.project.createProject({ id: 'p1', workspaceId: 'w1', name: 'Alpha', path: '/tmp/a' })
  const task = f.ledger.task.createTask({ projectId: 'p1', spec: 'blocked', now: night })
  f.ledger.task.blockTask(task.id, 'waiting on human')
  const run = f.ledger.run.startRun({ projectId: 'p1', depth: 0, startedAt: night })
  f.ledger.usage.recordUsage({ runId: run.id, inputTokens: 2000, outputTokens: 100, costMicros: 10_000, priceKnown: true, ts: night })

  f.clock.t = night + AWAY_GAP_MS + 10 // morning
  const brief = svc.get()
  expect(brief.since).toBe(T0 + 5 * 60_000)
  expect(brief.dismissed).toBe(false)
  expect(brief.lines.map((l) => l.id)).toEqual(['gates:needs_you', 'tests:node:t', 'restored:a', 'finished:a', 'checkpoints:w1', 'cost:total'])
  expect(brief.lines.find((l) => l.id === 'restored:a')?.text).toBe('node a was restored after the server restart')
  expect(brief.lines.some((l) => l.id === 'finished:old')).toBe(false)
})

test('cached: repeated opens do not re-read until an event lands; precompute warms it; well under 5 s', async () => {
  const f = fixture()
  let fire: (() => void) | null = null
  const { svc, reads } = service(f, { subscribe: (_p, fn) => { fire = fn; return () => { fire = null } } })
  for (let i = 0; i < 50; i++) f.log.append({ kind: 'hook.Stop', source: 'test', nodeId: `n${i % 5}`, trust: 'trusted' })
  const t = performance.now()
  svc.get()
  svc.get()
  expect(reads()).toBe(1)
  f.log.append({ kind: 'hook.Stop', source: 'test', nodeId: 'n9', trust: 'trusted' })
  fire!()
  await new Promise((r) => setTimeout(r, PRECOMPUTE_DEBOUNCE_MS + 50))
  expect(reads()).toBe(2) // rebuilt on the event, before anyone asked
  expect(svc.get().lines.some((l) => l.id === 'finished:n9')).toBe(true)
  expect(reads()).toBe(2) // served from the warm cache
  expect(performance.now() - t < 5000).toBe(true)
  svc.stop()
})

test('presence pings move the window; dismiss persists across a server restart for the same visit only', () => {
  const f = fixture()
  const path = statePath()
  let visible: number | null = null
  const deps = { statePath: path, lastVisibleAt: () => visible }
  const first = service(f, deps).svc
  f.clock.t = T0
  first.get()
  visible = T0 + 10 * 60_000 // tab stayed visible for 10 more minutes
  f.clock.t = T0 + 10 * 60_000
  expect(first.dismiss().dismissed).toBe(true)
  first.stop()

  // Restart in the same visit: still dismissed.
  const again = service(f, deps).svc
  expect(again.get().dismissed).toBe(true)
  again.stop()

  // Next morning: new visit, window starts at the last presence ping, card shows again.
  f.clock.t = T0 + 10 * 60_000 + AWAY_GAP_MS + 1
  const morning = service(f, deps).svc
  const brief = morning.get()
  expect(brief.since).toBe(T0 + 10 * 60_000)
  expect(brief.dismissed).toBe(false)
  expect(morning.peek().visitStartedAt).toBe(f.clock.t) // peek does not move the visit
})

test('route: GET + POST dismiss, 405 on wrong method, null for other paths, root-only', async () => {
  const f = fixture()
  const { svc } = service(f)
  expect(await briefRoute('/api/briefing', 'GET', svc)).toBeNull()
  expect(await briefRoute(BRIEF_PATH, 'POST', svc)).toMatchObject({ status: 405 })
  expect(await briefRoute(BRIEF_DISMISS_PATH, 'GET', svc)).toMatchObject({ status: 405 })
  expect(await briefRoute(BRIEF_PATH, 'GET', svc)).toMatchObject({ status: 200, body: { dismissed: false, lines: [] } })
  expect(await briefRoute(BRIEF_DISMISS_PATH, 'POST', svc)).toMatchObject({ status: 200, body: { dismissed: true } })
  expect(isNodeTokenPath(BRIEF_PATH)).toBe(false)
})

test('labels come from workspace titles, agent ids and split-pane parents', () => {
  const labels = workspaceLabels(() => [{
    id: 'w1', name: 'api', nodes: [{ id: 'n1', kind: 'terminal', x: 0, y: 0, title: 'Fix login' }, { id: 'n2', kind: 'terminal', x: 0, y: 0, agentId: 'claude' }],
  } as never])
  expect([labels.nodeLabel('n1'), labels.nodeLabel('n2'), labels.nodeLabel('n2:p1'), labels.nodeLabel('zzzzzzzzzz')]).toEqual(['Fix login in api', 'Claude in api', 'Claude in api', 'Node zzzzzzzz'])
  expect(labels.workspaceLabel('w1')).toBe('api')
})
