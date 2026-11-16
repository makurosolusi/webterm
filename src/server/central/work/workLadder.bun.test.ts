// The one escalation ladder: every open task (whoever opened its attempt) climbs nudge -> restart -> wake Central -> notice,
// every rung leaves an event with its rule and reason, no end leaves the end reason empty, and a tick storm sends one wake.
import { describe, expect, it } from 'bun:test'
import { appendCentralNotice } from '../chat/conversationNotice'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { createWorkCheckin, type CheckinSettingsPort, type CheckinTurn } from './workCheckin'
import { ESCALATE_EVENT, LEASE_RULE } from './workEscalation'
import { settleExecTask } from './workLifecycle'
import { LEASE_MS } from './workOwner'
import { createWorkStore, onWorkMove } from './workStore'
import { createWorkSupervisor, VANISHED_NO_RESPAWN, WORK_LIVENESS_RULES } from './workSupervisor'
import { fakePorts } from './workRig.testutil'

const SYSTEM = { kind: 'system' } as const
const { afterMs } = WORK_LIVENESS_RULES.escalate

function rig() {
  const db = freshDb()
  const clock = { t: T0 }
  const now = () => clock.t
  const store = createWorkStore(db, now)
  const settings: CheckinSettingsPort = { read: async () => ({ enabled: true, dailyLimit: 50 }), write: async () => {} }
  const turns: CheckinTurn[] = []
  const notice = (key: string, text: string, conversationId: string) => appendCentralNotice(db, { key, text, conversationId, kind: 'mock', now })
  const checkin = createWorkCheckin({ db, store, now, settings, submit: (t) => { turns.push(t); return `turn-${turns.length}` }, notice, env: {} })
  onWorkMove(db, checkin.onMove)
  const fake = fakePorts()
  const supervisor = createWorkSupervisor({ store, ports: fake.ports, now, afterTick: (at) => checkin.tick(at) })
  let n = 0
  /** A task with an open attempt opened by `actor`, moved to `status` along legal edges. */
  const open = (actor: { kind: 'central' } | { kind: 'human' }, status: 'running' | 'stalled' | 'reported' | 'needs_review' | 'failed', channel: 'terminal' | 'chat' = 'terminal') => {
    n += 1
    const id = `lt${n}`
    store.createTask({ id, projectId: 'p1', title: `ladder ${n}`, objective: 'o', actor: { kind: 'central' } })
    const a = store.openAssignment({ taskId: id, nodeId: `n-${id}`, channel, instruction: 'go', actor })
    const path: Record<string, string[]> = { running: ['running'], stalled: ['running', 'stalled'], reported: ['running', 'reported'], needs_review: ['running', 'reported', 'needs_review'], failed: ['running', 'failed'] }
    for (const to of path[status] as string[]) store.moveTask(id, to as 'running', { actor: SYSTEM, rule: 'test', assignmentId: a.id })
    return { id, assignmentId: a.id }
  }
  const events = (id: string) => store.timeline(id).filter((e) => e.kind === ESCALATE_EVENT)
  const count = (sql: string): number => (db.query(sql).get() as { n: number }).n
  return { db, clock, store, turns, checkin, supervisor, fake, open, events, count }
}

describe('lease ladder for tasks nobody works on', () => {
  it('a reported task whose verifier lease ran out wakes Central once, then tells the user, each rung with rule and reason', async () => {
    const r = rig()
    const t = r.open({ kind: 'central' }, 'reported')
    r.clock.t = T0 + LEASE_MS.verifier - 1
    await r.supervisor.tick(r.clock.t)
    expect(r.events(t.id)).toEqual([])
    r.clock.t = T0 + LEASE_MS.verifier
    await r.supervisor.tick(r.clock.t)
    expect(r.events(t.id).map((e) => [e.rule, e.reason?.split(':')[0]])).toEqual([[LEASE_RULE, 'reported']])
    expect(r.count("SELECT COUNT(*) AS n FROM central_checkin_reason WHERE task_id = 'lt1' AND dedupe_key LIKE 'lease:%:2'")).toBe(1)
    r.clock.t = T0 + LEASE_MS.verifier + afterMs
    await r.supervisor.tick(r.clock.t)
    expect(r.events(t.id)).toHaveLength(2)
    expect(r.count("SELECT COUNT(*) AS n FROM central_message WHERE role = 'system' AND parts_json LIKE '%nobody picking it up%'")).toBe(1)
  })

  it('a needs_review task is announced to the user when its human lease runs out', async () => {
    const r = rig()
    const t = r.open({ kind: 'central' }, 'needs_review')
    r.clock.t = T0 + LEASE_MS.human
    await r.supervisor.tick(r.clock.t)
    expect(r.events(t.id).map((e) => e.rule)).toEqual([LEASE_RULE])
    expect(r.count("SELECT COUNT(*) AS n FROM central_message WHERE role = 'system' AND parts_json LIKE '%waiting for your review%'")).toBe(1)
  })

  it('no flood: many ticks on one expired lease queue one wake and one notice per key', async () => {
    const r = rig()
    r.open({ kind: 'central' }, 'reported')
    r.open({ kind: 'central' }, 'needs_review')
    for (let i = 0; i < 12; i++) {
      r.clock.t = T0 + LEASE_MS.verifier + i * 30_000
      await r.supervisor.tick(r.clock.t)
    }
    expect(r.count("SELECT COUNT(*) AS n FROM central_checkin_reason WHERE dedupe_key LIKE 'lease:%'")).toBe(1)
    expect(r.count("SELECT COUNT(*) AS n FROM central_message WHERE role = 'system' AND parts_json LIKE '%waiting for your review%'")).toBe(1)
    expect(r.count(`SELECT COUNT(*) AS n FROM event WHERE kind = '${ESCALATE_EVENT}'`)).toBe(2)
  })
})

describe('the same ladder for work Central did not open', () => {
  it('a failed task opened by a human attempt is a duty: Central is woken at once, and the user is told after the notice window', async () => {
    const r = rig()
    const t = r.open({ kind: 'human' }, 'failed')
    expect(r.count("SELECT COUNT(*) AS n FROM central_checkin_reason WHERE task_id = 'lt1' AND dedupe_key LIKE 'wake:%'")).toBe(1)
    r.clock.t = T0 + WORK_LIVENESS_RULES.escalate.graceMs
    await r.supervisor.tick(r.clock.t)
    expect(r.turns).toHaveLength(1)
    r.clock.t = T0 + afterMs
    await r.supervisor.tick(r.clock.t)
    expect(r.events(t.id).at(-1)?.rule).toBe('escalate')
    expect(r.count("SELECT COUNT(*) AS n FROM central_message WHERE role = 'system' AND parts_json LIKE '%Central could not fix%'")).toBe(1)
  })

  it('a stalled human-opened task is stalled by the quiet lease like any other and wakes Central', async () => {
    const r = rig()
    const t = r.open({ kind: 'human' }, 'running')
    r.clock.t = T0 + LEASE_MS.agentActive
    await r.supervisor.tick(r.clock.t)
    expect(r.store.getTask(t.id)?.status).toBe('stalled')
    expect(r.count("SELECT COUNT(*) AS n FROM central_checkin_reason WHERE task_id = 'lt1' AND kind = 'task_stalled'")).toBe(1)
  })
})

describe('end_reason is never empty', () => {
  it('every way an attempt ends names why', async () => {
    const r = rig()
    // Terminal session vanished (no restart for terminals), exec failure, exec success then verifier-less end by the user, chat vanished twice.
    r.open({ kind: 'central' }, 'running')
    r.fake.state.live = false
    await r.supervisor.tick(T0 + 1000)
    const e = r.open({ kind: 'central' }, 'running')
    settleExecTask(r.db, () => T0 + 2000, `n-${e.id}`, { ok: false, reason: 'exit 1' })
    const c = r.open({ kind: 'central' }, 'running', 'chat')
    r.fake.state.chatGone = true
    await r.supervisor.tick(T0 + 3000)
    await r.supervisor.tick(T0 + 4000)
    expect(r.store.assignmentsOfTask(c.id, 5)[0]?.endReason).toBeTruthy()
    const ended = r.db.query('SELECT task_id AS t, end_reason AS why FROM central_assignment WHERE ended_at IS NOT NULL').all() as { t: string; why: string | null }[]
    expect(ended.length).toBeGreaterThan(1)
    for (const row of ended) expect(row.why).toBeTruthy()
    expect(ended.find((x) => x.t === 'lt1')?.why).toBe(VANISHED_NO_RESPAWN)
  })
})
