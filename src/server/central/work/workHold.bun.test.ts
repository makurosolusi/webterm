// Root-locking tests for the offline / rate-limit hold: no penalty, no wake, no rung while impaired; monotonic leases;
// one grace cycle after recovery; one event per episode; unchanged behaviour without a port.
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AssignmentView, WorkStatus } from '../../../shared/centralWork'
import type { ConnectivityState } from '../../connectivity/connectivity.port'
import { allRows } from '../../ledger/ledgerCore'
import { appendCentralNotice } from '../chat/conversationNotice'
import { checkinPrompt, createWorkCheckin, queueCheckinReason, type CheckinTurn } from './workCheckin'
import { createWorkHold, HOLD_WINDOW_MS, RECOVERY_GRACE_MS, type ConnectivityView } from './workHold'
import { createRateLimitHold } from './workRateLimit'
import { captureFromHook, stashStopResult } from './workResult'
import { createWorkSupervisor, WORK_LIVENESS_RULES as R } from './workSupervisor'
import { startWorkWatcher } from './workWatcher'
import { event, NODE, putTaskInStatus, rig, T0 } from './workRig.testutil'

const MIN = 60_000
const HOUR = 60 * MIN

/** A fake detector the test flips; `since` stands for the episode start. */
function fakeConn(): ConnectivityView & { down: boolean; since: number } {
  const c = {
    down: false, since: T0,
    isImpaired: () => c.down,
    state: (): ConnectivityState => ({ state: 'offline', since: c.since, cause: 'dns', scope: 'network', lastOkAt: null, consecutiveFailures: 3, consecutiveSuccesses: 0 }),
  }
  return c
}

function held() {
  const r = rig()
  const conn = fakeConn()
  const rate = createRateLimitHold()
  const holds: { episodeStart: number; reason: string }[] = []
  const hold = createWorkHold({ store: r.store, connectivity: conn, rateLimitResetAt: (n) => rate.resetAt(n), onHold: (i) => holds.push(i) })
  const supervisor = createWorkSupervisor({ store: r.store, ports: r.fake.ports, now: r.now, hold })
  return { ...r, conn, rate, holds, hold, supervisor }
}

const lease = (s: { store: { getAssignment(id: string): AssignmentView | null } }, id: string): number | null => s.store.getAssignment(id)?.leaseUntil ?? null

test('policy: while impaired no punishment transition happens (stalled, startup, nudge, chat respawn)', async () => {
  const s = held()
  const run = s.assigned('running')
  const fresh = s.assigned('assigned', { nodeId: 'n2' })
  const chat = s.assigned('running', { channel: 'chat', nodeId: 'n3' })
  s.fake.state.chatGone = true
  s.conn.down = true
  await s.supervisor.tick(T0 + 10 * HOUR)
  expect(s.statusOf(run.taskId)).toBe('running')
  expect(s.statusOf(fresh.taskId)).toBe('assigned')
  expect(s.statusOf(chat.taskId)).toBe('running')
  expect(s.fake.state.inputs).toEqual([])
  expect(s.fake.state.chats).toEqual([])
  expect(s.store.getAssignment(chat.assignmentId)?.restarts).toBe(0)
  // Control: the same world with the link up does punish, so the test above can fail.
  s.conn.down = false
  await s.supervisor.tick(T0 + 20 * HOUR)
  await s.supervisor.tick(T0 + 20 * HOUR + RECOVERY_GRACE_MS)
  expect(s.statusOf(run.taskId)).toBe('stalled')
})

test('a process that really died is still a fault under a hold (only chat respawn waits)', async () => {
  const s = held()
  const { taskId } = s.assigned('running')
  s.fake.state.live = false
  s.conn.down = true
  await s.supervisor.tick(T0 + MIN)
  expect(s.statusOf(taskId)).toBe('failed')
})

test('policy: the escalation ladder does not climb while impaired, and climbs after', async () => {
  const s = held()
  const { taskId } = s.assigned('running')
  putTaskInStatus(s.store, taskId, 'stalled')
  const notices: string[] = []
  const turns: CheckinTurn[] = []
  const checkin = createWorkCheckin({
    db: s.db, store: s.store, now: s.now, hold: s.hold, env: {},
    settings: { read: async () => ({ enabled: true, dailyLimit: 10 }), write: async () => {} },
    submit: (t) => { turns.push(t); return `turn-${turns.length}` },
    notice: (key, text, conversationId) => { notices.push(key); return appendCentralNotice(s.db, { key, text, conversationId, kind: 'mock', now: s.now }) },
  })
  const rows = (): number => allRows(s.db, "SELECT 1 FROM central_checkin_reason WHERE task_id = ? AND kind IN ('task_duty', 'task_report')", taskId).length
  s.conn.down = true
  await checkin.tick(T0 + 2 * HOUR)
  expect(notices).toEqual([])
  expect(rows()).toBe(0)
  s.conn.down = false
  await checkin.tick(T0 + 2 * HOUR + 1000)
  expect(notices).toEqual([])
  await checkin.tick(T0 + 2 * HOUR + RECOVERY_GRACE_MS + R.escalate.afterMs)
  expect(notices.length + rows()).toBeGreaterThan(0)
})

test('hold never shortens a lease and never touches restart_limit', async () => {
  const s = held()
  const { assignmentId } = s.assigned('running')
  s.store.holdLeases(T0 + 5 * HOUR)
  s.conn.down = true
  await s.supervisor.tick(T0 + MIN)
  expect(lease(s, assignmentId)).toBe(T0 + 5 * HOUR)
  const short = s.assigned('running', { nodeId: 'n9' })
  const tickAt = T0 + 5 * MIN + 30_000 // past the fresh lease minus the window, so the hold must push it
  await s.supervisor.tick(tickAt)
  expect(lease(s, short.assignmentId)).toBe(tickAt + HOLD_WINDOW_MS)
  expect(s.store.getAssignment(short.assignmentId)?.restarts).toBe(0)
})

test('one grace cycle after recovery: not stalled at the first tick, stalled once the grace is spent', async () => {
  const s = held()
  const { taskId } = s.assigned('running')
  s.conn.down = true
  await s.supervisor.tick(T0 + 10 * MIN)
  s.conn.down = false
  const back = T0 + 20 * MIN
  await s.supervisor.tick(back)
  expect(s.statusOf(taskId)).toBe('running')
  await s.supervisor.tick(back + RECOVERY_GRACE_MS - 1)
  expect(s.statusOf(taskId)).toBe('running')
  await s.supervisor.tick(back + RECOVERY_GRACE_MS)
  expect(s.statusOf(taskId)).toBe('stalled')
})

test('the hold event is written once per episode, not per tick or per task', async () => {
  const s = held()
  s.assigned('running')
  s.assigned('running', { nodeId: 'n2' })
  s.conn.down = true
  s.conn.since = T0 + 5
  for (let i = 1; i <= 5; i++) await s.supervisor.tick(T0 + i * 30_000)
  expect(s.holds).toEqual([{ episodeStart: T0 + 5, reason: 'offline:dns' }])
  s.conn.down = false
  await s.supervisor.tick(T0 + 10 * MIN)
  s.conn.down = true
  s.conn.since = T0 + 11 * MIN
  await s.supervisor.tick(T0 + 12 * MIN)
  await s.supervisor.tick(T0 + 13 * MIN)
  expect(s.holds).toHaveLength(2)
})

function watcher(s: ReturnType<typeof rig>) {
  return startWorkWatcher({ store: s.store, now: s.now, bus: s.bus, onReported: () => {}, onSessionEnded: () => {} })
}
const failure = (error: string, details?: string) => stashStopResult(NODE, captureFromHook({ hook_event_name: 'StopFailure', error, ...(details ? { error_details: details } : {}) }, T0, undefined, () => null))

test('StopFailure of a transient class keeps the task running and records one interruption', () => {
  for (const [error, details, kind] of [['unknown', "Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'network'], ['rate_limit', undefined, 'rate_limited'], ['overloaded', undefined, 'overloaded'], ['server_error', undefined, 'server']] as const) {
    const s = rig()
    watcher(s)
    const { taskId, assignmentId } = s.assigned('running')
    for (let i = 0; i < 2; i++) { failure(error, details); s.bus.publish(event('hook.StopFailure')) }
    expect(s.statusOf(taskId)).toBe('running')
    const notes = s.store.timeline(taskId).filter((e) => e.kind === 'work.interrupted')
    expect(notes.map((e) => e.reason)).toEqual([kind])
    expect(s.store.getAssignment(assignmentId)?.leaseUntil).toBe(T0 + R.stalled.afterMs)
  }
})

test('StopFailure of auth or permanent class keeps the old path (stalled, for a human)', () => {
  for (const error of ['authentication_failed', 'billing_error', 'invalid_request']) {
    const s = rig()
    watcher(s)
    const { taskId } = s.assigned('running')
    failure(error)
    s.bus.publish(event('hook.StopFailure'))
    expect(s.statusOf(taskId)).toBe('stalled')
    expect(s.store.timeline(taskId).some((e) => e.kind === 'work.interrupted')).toBe(false)
  }
})

function checkinRig(s: ReturnType<typeof held>) {
  const turns: CheckinTurn[] = []
  const checkin = createWorkCheckin({
    db: s.db, store: s.store, now: s.now, hold: s.hold, env: {},
    settings: { read: async () => ({ enabled: true, dailyLimit: 10 }), write: async () => {} },
    submit: (t) => { turns.push(t); return `turn-${turns.length}` },
    notice: (key, text, conversationId) => appendCentralNotice(s.db, { key, text, conversationId, kind: 'mock', now: s.now }),
  })
  return { turns, checkin }
}
const unsent = (db: Database): number => allRows(db, 'SELECT 1 FROM central_checkin_reason WHERE sent_at IS NULL').length

test('a check-in is not sent while impaired (reason stays unsent) and goes out after recovery', async () => {
  const s = held()
  const { turns, checkin } = checkinRig(s)
  // Due now (not_before set): even an urgent reason must wait.
  queueCheckinReason(s.db, { kind: 'reminder_due', dedupeKey: 'r1', projectId: 'p1', taskId: null, text: 'look', now: T0, notBefore: T0 })
  s.conn.down = true
  await checkin.tick(T0 + MIN)
  expect(turns).toEqual([])
  expect(unsent(s.db)).toBe(1)
  s.conn.down = false
  await checkin.tick(T0 + 2 * MIN)
  expect(turns).toHaveLength(1)
  expect(unsent(s.db)).toBe(0)
  expect(checkinPrompt([{ kind: 'x', projectId: null, taskId: null, text: 't', createdAt: T0 }])).toContain('t')
})

test('rate limit: the reset instant is normalized from seconds and from ms, and holds penalties and check-ins until then', async () => {
  const resetMs = T0 + 30 * MIN
  for (const raw of [resetMs / 1000, resetMs]) {
    const r = createRateLimitHold()
    r.note({ status: 'rejected', resetsAt: raw })
    expect(r.resetAt(T0)).toBe(resetMs)
    expect(r.resetAt(resetMs)).toBeNull()
    r.note({ status: 'allowed_warning', resetsAt: raw + 1e9 })
    expect(r.resetAt(T0)).toBe(resetMs)
  }
  const s = held()
  const { taskId } = s.assigned('running')
  const { turns, checkin } = checkinRig(s)
  queueCheckinReason(s.db, { kind: 'reminder_due', dedupeKey: 'r2', projectId: 'p1', taskId: null, text: 'look', now: T0, notBefore: T0 })
  s.rate.note({ status: 'rejected', resetsAt: resetMs / 1000 })
  await s.supervisor.tick(resetMs - 1)
  await checkin.tick(resetMs - 1)
  expect(s.statusOf(taskId)).toBe('running')
  expect(turns).toEqual([])
  expect(s.holds.map((h) => h.reason)).toEqual(['rate_limited'])
  await s.supervisor.tick(resetMs + 1)
  expect(s.statusOf(taskId)).toBe('running')
  await checkin.tick(resetMs + 1)
  expect(turns).toHaveLength(1)
  await s.supervisor.tick(resetMs + 1 + RECOVERY_GRACE_MS)
  expect(s.statusOf(taskId)).toBe('stalled')
})

test('without a connectivity port or rate limit the supervisor behaves as before', async () => {
  const s = rig()
  const hold = createWorkHold({ store: s.store, connectivity: null })
  const sup = createWorkSupervisor({ store: s.store, ports: s.fake.ports, now: s.now, hold })
  const { taskId } = s.assigned('running')
  const before: WorkStatus | undefined = s.statusOf(taskId)
  await sup.tick(T0 + R.stalled.afterMs)
  expect(before).toBe('running')
  expect(s.statusOf(taskId)).toBe('stalled')
})
