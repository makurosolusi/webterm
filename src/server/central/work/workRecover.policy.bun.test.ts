// Root-lock of the recovery sweep: whatever the failure class and whatever state the agent is in, a victim ends in
// exactly one of recovered / rescheduled / escalated, never silent; nothing is retried that money or a login must fix.
import { expect, test } from 'bun:test'
import type { AgentState } from '../contracts'
import type { FailureKind } from './workFailureKind'
import { RECOVER_EVENT } from './workRecover.model'
import { MIN, T0, recoverRig } from './workRecover.testutil'

const CLASSES: readonly FailureKind[] = ['network', 'rate_limited', 'overloaded', 'server', 'auth', 'permanent']
const TRANSIENT: readonly FailureKind[] = ['network', 'rate_limited', 'overloaded', 'server']

interface Shape { name: string; agentState: AgentState; live: boolean; setup?: (w: ReturnType<typeof recoverRig>['world']) => void }
const SHAPES: readonly Shape[] = [
  { name: 'idle', agentState: 'waiting_input', live: true },
  { name: 'busy', agentState: 'working', live: true },
  { name: 'dead, transcript there', agentState: 'orphaned', live: false },
  { name: 'dead, transcript missing', agentState: 'session_exited', live: false, setup: (w) => { w.resume = { ok: false, code: 'transcript_missing' } } },
  { name: 'dead, too old', agentState: 'orphaned', live: false, setup: (w) => { w.resume = { ok: false, code: 'too_old' } } },
  { name: 'dead, no respawn room', agentState: 'orphaned', live: false, setup: (w) => { w.resume = { ok: false, code: 'too_old' }; w.respawn = { ok: false, code: 'cap_project' } } },
  { name: 'dead, spawn needs a card', agentState: 'orphaned', live: false, setup: (w) => { w.resume = { ok: false, code: 'too_old' }; w.respawn = { ok: false, code: 'approval_required' } } },
]

test('policy: every failure class x agent state ends in exactly one of recovered / rescheduled / escalated', async () => {
  for (const kind of CLASSES) {
    for (const shape of SHAPES) {
      const s = recoverRig()
      s.outage()
      shape.setup?.(s.world)
      s.setNow(T0 + MIN)
      const v = s.victim({ kind, agentState: shape.agentState, live: shape.live })
      s.setNow(T0 + 11 * MIN)
      await s.recover.sweep(s.key())
      const done = s.finalOf(v.taskId)
      const label = `${kind} / ${shape.name}`
      expect([label, done !== undefined]).toEqual([label, true])
      expect([label, ['recovered', 'rescheduled', 'escalated'].includes(done?.outcome as string)]).toEqual([label, true])
      // A class a human must fix is never touched: no prompt, no resume, no respawn.
      if (!TRANSIENT.includes(kind)) {
        expect([label, done?.outcome]).toEqual([label, 'escalated'])
        expect([label, s.calls.reprompt.length + s.calls.resume.length + s.calls.respawn.length]).toEqual([label, 0])
      }
    }
  }
})

test('policy: the rung each transient case lands on', async () => {
  const expected: Record<string, [string, number]> = {
    idle: ['recovered', 1], busy: ['rescheduled', 0], 'dead, transcript there': ['recovered', 2], 'dead, transcript missing': ['recovered', 3],
    'dead, too old': ['recovered', 3], 'dead, no respawn room': ['rescheduled', 0], 'dead, spawn needs a card': ['escalated', 3],
  }
  for (const shape of SHAPES) {
    const s = recoverRig()
    s.outage()
    shape.setup?.(s.world)
    s.setNow(T0 + MIN)
    const v = s.victim({ agentState: shape.agentState, live: shape.live })
    s.setNow(T0 + 11 * MIN)
    await s.recover.sweep(s.key())
    expect([shape.name, s.finalOf(v.taskId)?.outcome, s.finalOf(v.taskId)?.rung]).toEqual([shape.name, ...(expected[shape.name] as [string, number])])
  }
})

test('an escalated victim wakes Central once through the durable queue, with its reason', async () => {
  const s = recoverRig()
  s.outage()
  s.world.resume = { ok: false, code: 'too_old' }
  s.world.respawn = { ok: false, code: 'approval_required' }
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'orphaned', live: false })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  await s.recover.sweep(s.key(), true)
  const rows = s.reasons().filter((r) => r.task_id === v.taskId)
  expect(rows.length).toBe(1)
  expect(rows[0]?.kind).toBe('task_failed')
  expect(String(rows[0]?.text)).toContain('needs_approval')
})

test('a victim that carried on by itself is recorded but not counted in what the user is told', async () => {
  const s = recoverRig()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'working', live: true })
  s.setNow(T0 + 2 * MIN)
  s.store.touchSignal(v.assignmentId, 'hook.PostToolUse', s.now())
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(s.finalOf(v.taskId)).toMatchObject({ outcome: 'recovered', reason: 'carried_on', acted: false })
  expect(s.announced.length).toBe(0)
  expect(s.calls.reprompt.length).toBe(0)
})

test('events are bounded: a victim that keeps waiting says the same thing once', async () => {
  const s = recoverRig()
  s.outage()
  s.setNow(T0 + MIN)
  const v = s.victim({ agentState: 'working', live: true })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  for (let i = 0; i < 5; i += 1) await s.recover.sweep(s.key(), true)
  expect(s.recoverEvents(v.taskId).filter((e) => e.reason === 'busy').length).toBe(1)
  expect(s.count(RECOVER_EVENT)).toBe(1)
})
