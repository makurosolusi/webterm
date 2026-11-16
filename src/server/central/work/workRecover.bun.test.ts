// Root-lock of the recovery sweep's triggers and bounds: idempotent per key, silent while impaired, hard limits,
// quota and pause respected, refusals fall to a clean respawn, one notice per episode, rate-limit timer, boot trigger.
import { expect, test } from 'bun:test'
import { createControlGuard } from '../guard/controlGuard'
import { PROJECT_PAUSED } from '../centralModel'
import { appendEvent } from '../../ledger/ledgerEvent'
import type { TaskView } from '../../../shared/centralWork'
import { createWorkCheckin } from './workCheckin'
import { MAX_REPROMPTS, RECOVER_RULE, RECOVER_ACTOR, RECOVER_EVENT, SUMMARY_EVENT, SWEEP_GRACE_MS, TIMER_SLACK_MS } from './workRecover.model'
import { clockOf, createWorkRecover } from './workRecover'
import { MIN, T0, episodeAt, recoverRig } from './workRecover.testutil'

const HOUR = 60 * MIN

/** A victim hit inside the outage and a sweep at `T0 + 11 min`; returns the rig after the first sweep. */
async function swept(setup: (s: ReturnType<typeof recoverRig>) => void = () => {}) {
  const s = recoverRig()
  s.outage()
  setup(s)
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'waiting_input', live: true })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  return { s, v }
}

test('idempotent: the same key swept twice, or triggered twice, acts once', async () => {
  const { s, v } = await swept()
  await s.recover.sweep(s.key())
  s.recover.attach()
  s.detector.emit('online', 'offline')
  s.detector.emit('online', 'offline')
  s.ticker.fire()
  await s.recover.idle()
  expect(s.calls.reprompt).toEqual([v.agentId as string])
  expect(s.recoverEvents(v.taskId).length).toBe(1)
  expect(s.announced.length).toBe(1)
})

test('the link coming back sweeps after the grace, never before', async () => {
  const s = recoverRig()
  s.recover.attach()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'waiting_input', live: true })
  s.setNow(T0 + 11 * MIN)
  s.detector.emit('online', 'offline')
  expect(s.ticker.pending()).toEqual([SWEEP_GRACE_MS])
  expect(s.calls.reprompt.length).toBe(0)
  s.ticker.fire()
  await s.recover.idle()
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', rung: 1 })
})

test('nothing runs while the link is impaired or a rate limit is pending; the sweep waits for the next recovery', async () => {
  const s = recoverRig()
  s.recover.attach()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'waiting_input', live: true })
  s.setNow(T0 + 11 * MIN)
  s.detector.down = true
  await s.recover.sweep(s.key())
  expect(s.calls.reprompt.length + s.recoverEvents(v.taskId).length).toBe(0)
  s.detector.down = false
  s.rate.note({ status: 'rejected', resetsAt: s.now() + HOUR })
  await s.recover.sweep(s.key())
  expect(s.calls.reprompt.length).toBe(0)
  s.setNow(s.now() + 2 * HOUR)
  s.detector.emit('online', 'offline')
  s.ticker.fire()
  await s.recover.idle()
  expect(s.calls.reprompt.length).toBe(1)
})

test('hard limits: a reprompt that keeps failing stops at MAX_REPROMPTS and a human is told', async () => {
  const { s, v } = await swept((r) => { r.world.reprompt = { ok: false, code: 'submit_failed' } })
  for (let i = 0; i < MAX_REPROMPTS + 2; i += 1) await s.recover.sweep(s.key(), true)
  expect(s.calls.reprompt.length).toBe(MAX_REPROMPTS)
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'escalated', reason: 'limit:reprompt' })
  expect(s.reasons().filter((r) => r.task_id === v.taskId).length).toBe(1)
})

test('hard limits: resume is tried at most twice, a clean respawn once', async () => {
  const s = recoverRig()
  s.outage()
  s.world.resume = { ok: false, code: 'launch_failed' }
  s.world.respawn = { ok: false, code: 'cap_project' }
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'orphaned', live: false })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  for (let i = 0; i < 3; i += 1) await s.recover.sweep(s.key(), true)
  expect(s.calls.resume.length).toBe(2)
  // A respawn that keeps meeting a full quota never counts as tried, so it is never escalated for that.
  expect(s.finalOf(v.taskId)?.outcome).toBe('rescheduled')
  appendEvent({ db: s.db, now: s.now }, { kind: RECOVER_EVENT, actor: RECOVER_ACTOR, correlationId: v.taskId, payload: { episode: 'episode:e1', rung: 3, acted: true, outcome: 'fallthrough' } })
  await s.recover.sweep(s.key(), true)
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'escalated', reason: 'limit:respawn' })
})

test('a full worker quota or a paused project waits (rescheduled) and never escalates', async () => {
  const { s, v } = await swept((r) => { r.world.live.clear(); r.world.resume = { ok: false, code: 'too_old' }; r.world.respawn = { ok: false, code: 'cap_global' } })
  // The default victim is live; make a dead one for the quota case.
  const dead = s.victim({ agentState: 'orphaned', live: false })
  await s.recover.sweep(s.key(), true)
  expect(s.finalOf(dead.taskId)).toMatchObject({ outcome: 'rescheduled', reason: 'spawn:cap_global' })
  expect(s.reasons().length).toBe(0)
  expect(s.ticker.pending().length).toBeGreaterThan(0)
  expect(v.taskId).not.toBe(dead.taskId)
})

test('project pause and level are honoured through the real guard: no action, victim waits', async () => {
  const s = recoverRig()
  s.outage()
  const guard = createControlGuard({ db: s.db, now: s.now, env: {} })
  s.world.permit = { ok: true }
  s.ports.permit = (projectId, tool) => { const d = guard.check({ action: 'tool', projectId, tool, tier: 'R1' }); return d.verdict === 'allow' ? { ok: true } : { ok: false, code: d.verdict === 'deny' ? d.code : 'needs_approval' } }
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'waiting_input', live: true })
  s.db.query('UPDATE project SET status = ? WHERE id = ?').run(PROJECT_PAUSED, 'p1')
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(s.calls.reprompt.length).toBe(0)
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'rescheduled', reason: 'control:project_paused' })
  s.db.query("UPDATE project SET status = 'active' WHERE id = ?").run('p1')
  await s.recover.sweep(s.key(), true)
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', rung: 1 })
})

test('a refused resume falls to a clean respawn: new agent, task reopened on it, brief with goal, partial result and git advice', async () => {
  const s = recoverRig()
  s.outage()
  s.world.resume = { ok: false, code: 'transcript_missing' }
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'session_exited', live: false })
  s.store.recordResult(v.assignmentId, { source: 'stop_hook', text: 'edited three files, tests not run', truncated: false, at: s.now(), hash: 'h1' })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(s.calls.resume.length).toBe(1)
  expect(s.calls.respawn.length).toBe(1)
  expect(s.calls.respawn[0]?.title).toContain('title')
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', rung: 3 })
  const open = s.store.openAssignmentOfTask(v.taskId)
  expect(open).toMatchObject({ agentId: 'ag-new', nodeId: 'c-ag-new', channel: 'spawn' })
  expect(s.statusOf(v.taskId)).toBe('assigned')
  const brief = s.calls.brief[0] as string
  expect(brief).toContain('edited three files')
  expect(brief).toContain('git status')
  expect(brief).toContain('Goal: title')
  // The status hop of the replaced session is silent: it queued no wake for Central.
  expect(s.reasons().length).toBe(0)
})

test('a dead agent with a usable transcript is resumed (rung 2) and its task keeps its attempt', async () => {
  const s = recoverRig()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'orphaned', live: false })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(s.calls.resume).toEqual([v.agentId as string])
  expect(s.calls.respawn.length).toBe(0)
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', rung: 2 })
  expect(s.store.openAssignmentOfTask(v.taskId)?.id).toBe(v.assignmentId)
})

test('a task that already failed as vanished inside the outage is reopened on the resumed agent', async () => {
  const s = recoverRig()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'session_exited', live: false, note: false })
  s.setNow(T0 + 2 * MIN)
  s.store.moveTask(v.taskId, 'failed', { actor: { kind: 'system' }, rule: 'vanished', reason: 'vanished_no_respawn', assignmentId: v.assignmentId })
  s.store.endAssignment(v.assignmentId, 'vanished_no_respawn', undefined, { actor: { kind: 'system' }, rule: 'vanished' })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(s.calls.resume.length).toBe(1)
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', rung: 2 })
  expect(s.statusOf(v.taskId)).toBe('assigned')
  expect(s.store.openAssignmentOfTask(v.taskId)).toMatchObject({ agentId: v.agentId, attempt: 2 })
})

test('a task a human cancelled is never brought back', async () => {
  const s = recoverRig()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'cancelled', live: false })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(s.calls.resume.length + s.calls.respawn.length + s.calls.reprompt.length).toBe(0)
  expect(s.recoverEvents(v.taskId).length).toBe(0)
})

test('one notice and one summary event per episode, with the real counts; none when nothing was affected', async () => {
  const s = recoverRig()
  s.outage()
  s.world.resume = { ok: false, code: 'too_old' }
  s.world.respawn = { ok: false, code: 'approval_required' }
  s.setNow(T0 + MIN)
  s.victim({ agentState: 'waiting_input', live: true })
  s.victim({ agentState: 'waiting_input', live: true })
  s.victim({ agentState: 'orphaned', live: false })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  await s.recover.sweep(s.key())
  await s.recover.sweep(s.key(), true)
  expect(s.announced).toEqual([{ key: 'recover:episode:e1', text: `Connection was down ${clockOf(T0)}–${clockOf(T0 + 10 * MIN)} · 3 tasks affected: 2 resumed, 1 needs you` }])
  expect(s.count(SUMMARY_EVENT)).toBe(1)
  const quiet = recoverRig()
  quiet.outage()
  quiet.setNow(T0 + 11 * MIN)
  await quiet.recover.sweep(quiet.key())
  expect(quiet.announced.length).toBe(0)
  expect(quiet.count(SUMMARY_EVENT)).toBe(0)
})

test('a 429 schedules its sweep at the reset instant, not by polling, and acts after it', async () => {
  const s = recoverRig()
  s.setNow(T0)
  const v = s.victim({ kind: 'rate_limited', agentState: 'waiting_input', live: true })
  const resetAt = T0 + 30 * MIN
  s.recover.attach()
  s.rate.note({ status: 'rejected', resetsAt: resetAt })
  s.rate.note({ status: 'rejected', resetsAt: resetAt })
  expect(s.ticker.pending()).toEqual([30 * MIN + TIMER_SLACK_MS])
  s.setNow(resetAt + TIMER_SLACK_MS)
  s.ticker.fire()
  await s.recover.idle()
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', rung: 1, kind: 'rate_limited' })
  expect(s.announced[0]?.text).toContain('rate limit')
  // A network casualty is not this key's business.
  const net = recoverRig()
  net.victim({ kind: 'network', agentState: 'waiting_input', live: true })
  net.recover.attach()
  net.rate.note({ status: 'rejected', resetsAt: net.now() + MIN })
  net.setNow(net.now() + MIN + TIMER_SLACK_MS)
  net.ticker.fire()
  await net.recover.idle()
  expect(net.calls.reprompt.length).toBe(0)
})

test('boot with an unswept outage sweeps once; an old swept one, or no detector, does nothing', async () => {
  const s = recoverRig()
  const v = s.victim({ agentState: 'waiting_input', live: true })
  s.setNow(T0 + 11 * MIN)
  s.detector.list = [episodeAt(T0, T0 + 10 * MIN)]
  s.recover.attach()
  await s.recover.idle()
  expect(s.calls.reprompt).toEqual([v.agentId as string])
  s.recover.stop()
  s.recover.attach()
  await s.recover.idle()
  expect(s.calls.reprompt.length).toBe(1)
  const none = recoverRig()
  none.victim({ agentState: 'waiting_input', live: true })
  const off = createWorkRecover({ db: none.db, store: none.store, now: none.now, ports: none.ports, connectivity: () => null, timers: none.ticker.timers, announce: () => { throw new Error('no detector, no notice') } })
  off.attach()
  await off.idle()
  expect(none.calls.reprompt.length + none.count(RECOVER_EVENT)).toBe(0)
  const open = recoverRig()
  open.detector.list = [episodeAt(T0, null)]
  open.detector.down = true
  open.recover.attach()
  await open.recover.idle()
  expect(open.count(RECOVER_EVENT)).toBe(0)
})

test('the sweep\'s own status hop is silent for the check-in engine', () => {
  const s = recoverRig()
  const checkin = createWorkCheckin({ db: s.db, store: s.store, now: s.now, settings: { read: async () => ({ enabled: true, dailyLimit: 10 }), write: async () => {} }, submit: () => 't', notice: () => true })
  const { taskId } = s.assigned('running')
  const task = s.store.getTask(taskId) as TaskView
  const move = (rule: string | null) => ({ task, from: 'running' as const, to: 'stalled' as const, rule, reason: null, channel: 'spawn' as const, seq: rule === null ? 1 : 2 })
  expect(checkin.onMove(move(RECOVER_RULE))).toBe(false)
  expect(s.reasons().length).toBe(0)
  checkin.onMove(move('stalled'))
  expect(s.reasons().length).toBe(1)
})
