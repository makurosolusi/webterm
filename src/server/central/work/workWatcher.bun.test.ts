import { expect, test } from 'bun:test'
import type { AssignmentView, WorkStatus } from '../../../shared/centralWork'
import type { WorkStore } from './workModel'
import { WORK_LIVENESS_RULES } from './workSupervisor'
import { startWorkWatcher } from './workWatcher'
import { event, NODE, rig } from './workRig.testutil'

function setup() {
  const r = rig()
  const reported: string[] = []
  const ended: { a: AssignmentView; cause: string }[] = []
  const off = startWorkWatcher({ store: r.store, now: r.now, bus: r.bus, onReported: (id) => reported.push(id), onSessionEnded: (a, cause) => ended.push({ a, cause }) })
  return { ...r, reported, ended, off }
}

const BUSY_EVENTS = [['hook.UserPromptSubmit', {}], ['hook.PreToolUse', { toolName: 'Bash' }], ['hook.PostToolUse', { toolName: 'Bash' }], ['agentChat.turn_start', {}]] as const
const BUSY_FROM: WorkStatus[] = ['assigned', 'stalled', 'waiting_input', 'reported', 'needs_review', 'verifying']

for (const [kind, payload] of BUSY_EVENTS) {
  for (const from of BUSY_FROM) {
    test(`${kind} moves ${from} to running and touches the signal`, () => {
      const s = setup()
      const { taskId, assignmentId } = s.assigned(from)
      s.bus.publish(event(kind, payload))
      expect(s.statusOf(taskId)).toBe('running')
      expect(s.lastRule(taskId)).toBe('activity')
      expect(s.store.getAssignment(assignmentId)?.lastSignal).toBe(kind)
    })
  }
}

test('a subagent tool event is ignored entirely', () => {
  const s = setup()
  const { taskId, assignmentId } = s.assigned('stalled')
  s.bus.publish(event('hook.PostToolUse', { subagent: true }))
  s.bus.publish(event('hook.PreToolUse', { subagent: true }))
  expect(s.statusOf(taskId)).toBe('stalled')
  expect(s.store.getAssignment(assignmentId)?.lastSignal).toBeNull()
})

test('untrusted and nodeless events are ignored', () => {
  const s = setup()
  const { taskId } = s.assigned('assigned')
  s.bus.publish(event('hook.UserPromptSubmit', {}, NODE, 'untrusted'))
  s.bus.publish(event('hook.UserPromptSubmit', {}, null))
  expect(s.statusOf(taskId)).toBe('assigned')
})

for (const kind of ['hook.Stop', 'agentChat.turn_end'] as const) {
  test(`${kind} moves running to reported with its rule and starts verification`, () => {
    const s = setup()
    const { taskId } = s.assigned('running')
    s.bus.publish(event(kind, kind === 'agentChat.turn_end' ? { outcome: 'ok' } : {}))
    expect(s.statusOf(taskId)).toBe('reported')
    expect(s.lastRule(taskId)).toBe('stop_without_report')
    expect(s.reported).toEqual([taskId])
  })
}

test('Stop on a stalled task reports it', () => {
  const s = setup()
  const { taskId } = s.assigned('stalled')
  s.bus.publish(event('hook.Stop'))
  expect(s.statusOf(taskId)).toBe('reported')
})

test('policy: a Stop on a tracked node can never leave it running', () => {
  const statuses: WorkStatus[] = ['assigned', 'running', 'waiting_input', 'stalled', 'reported', 'verifying', 'needs_review']
  for (const from of statuses) {
    const s = setup()
    const { taskId } = s.assigned(from)
    s.bus.publish(event('hook.Stop'))
    expect(s.statusOf(taskId)).not.toBe('running')
    expect(s.statusOf(taskId)).toBe(from === 'running' || from === 'stalled' ? 'reported' : from)
  }
})

for (const [kind, payload] of [['hook.StopFailure', {}], ['agentChat.turn_end', { outcome: 'error' }], ['agentChat.turn_end', { outcome: 'interrupted' }]] as const) {
  test(`${kind} ${JSON.stringify(payload)} moves running to stalled, rule stop_failure`, () => {
    const s = setup()
    const { taskId } = s.assigned('running')
    s.bus.publish(event(kind, payload))
    expect(s.statusOf(taskId)).toBe('stalled')
    expect(s.lastRule(taskId)).toBe('stop_failure')
    expect(s.reported).toEqual([])
  })
}

const INPUT_EVENTS = [['hook.PermissionRequest', {}], ['hook.Notification', { notificationType: 'permission_prompt' }], ['hook.Notification', { notificationType: 'agent_needs_input' }], ['hook.Notification', { notificationType: 'elicitation_dialog' }], ['agentChat.needs_input', {}]] as const
for (const [kind, payload] of INPUT_EVENTS) {
  test(`${kind} ${JSON.stringify(payload)} moves running to waiting_input`, () => {
    const s = setup()
    const { taskId } = s.assigned('running')
    s.bus.publish(event(kind, payload))
    expect(s.statusOf(taskId)).toBe('waiting_input')
    expect(s.lastRule(taskId)).toBe('needs_input')
  })
}

test('needs input from assigned goes through running', () => {
  const s = setup()
  const { taskId } = s.assigned('assigned')
  s.bus.publish(event('hook.PermissionRequest'))
  expect(s.statusOf(taskId)).toBe('waiting_input')
  expect(s.store.timeline(taskId).filter((e) => e.to !== null).map((e) => e.to)).toEqual(['todo', 'assigned', 'running', 'waiting_input'])
})

test('an unrelated Notification neither moves nor touches', () => {
  const s = setup()
  const { taskId, assignmentId } = s.assigned('running')
  s.bus.publish(event('hook.Notification', { notificationType: 'idle_prompt' }))
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.store.getAssignment(assignmentId)?.lastSignal).toBeNull()
})

for (const kind of ['hook.SessionEnd', 'pty.exit', 'agentChat.closed'] as const) {
  for (const from of ['reported', 'verifying', 'needs_review'] as WorkStatus[]) {
    test(`${kind} on ${from} ends the assignment and leaves the task`, () => {
      const s = setup()
      const { taskId, assignmentId } = s.assigned(from)
      s.bus.publish(event(kind))
      expect(s.statusOf(taskId)).toBe(from)
      const a = s.store.getAssignment(assignmentId)
      expect(a?.endReason).toBe('session_end')
      expect(a?.endedAt).not.toBeNull()
      expect(s.ended).toEqual([])
    })
  }
  for (const from of ['assigned', 'running', 'stalled', 'waiting_input'] as WorkStatus[]) {
    test(`${kind} on ${from} is treated as vanished`, () => {
      const s = setup()
      const { assignmentId } = s.assigned(from)
      s.bus.publish(event(kind))
      expect(s.ended.map((e) => [e.a.id, e.cause])).toEqual([[assignmentId, kind]])
    })
  }
}

test('events on an untracked node do nothing', () => {
  const s = setup()
  const { taskId } = s.assigned('running', { nodeId: 'other' })
  s.bus.publish(event('hook.Stop'))
  expect(s.statusOf(taskId)).toBe('running')
})

test('a throwing store does not kill the subscriber', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  const real = s.store.moveTask
  let fail = true
  const store: WorkStore = { ...s.store, moveTask: (id, to, o) => { if (fail) { fail = false; throw new Error('db locked') } return real(id, to, o) } }
  s.off()
  startWorkWatcher({ store, now: s.now, bus: s.bus, onReported: () => {}, onSessionEnded: () => {} })
  expect(s.bus.subscriberCount).toBe(3)
  s.bus.publish(event('hook.Stop'))
  expect(s.bus.subscriberCount).toBe(3)
  expect(s.statusOf(taskId)).toBe('running')
  s.bus.publish(event('hook.Stop'))
  expect(s.statusOf(taskId)).toBe('reported')
})

test('two watchers on one bus do not double-move', () => {
  const s = setup()
  const reported2: string[] = []
  startWorkWatcher({ store: s.store, now: s.now, bus: s.bus, onReported: (id) => reported2.push(id), onSessionEnded: () => {} })
  const { taskId } = s.assigned('running')
  s.bus.publish(event('hook.Stop'))
  expect(s.statusOf(taskId)).toBe('reported')
  expect(s.reported.length + reported2.length).toBe(1)
  expect(s.store.timeline(taskId).filter((e) => e.to === 'reported').length).toBe(1)
})

test('unsubscribes from every pattern', () => {
  const s = setup()
  expect(s.bus.subscriberCount).toBe(3)
  s.off()
  expect(s.bus.subscriberCount).toBe(0)
})

test('thresholds are the agreed ones', () => {
  expect([WORK_LIVENESS_RULES.startup.afterMs, WORK_LIVENESS_RULES.heartbeat.afterMs, WORK_LIVENESS_RULES.stalled.afterMs]).toEqual([120_000, 600_000, 1_200_000])
})
