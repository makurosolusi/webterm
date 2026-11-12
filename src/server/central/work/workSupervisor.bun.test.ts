import { expect, test } from 'bun:test'
import type { WorkStore } from './workModel'
import { finishTask } from './workLifecycle'
import { createWorkSupervisor, VANISHED_NO_RESPAWN, WORK_LIVENESS_RULES as R } from './workSupervisor'
import { rig, T0 } from './workRig.testutil'

const at = (ms: number) => T0 + ms

test('startup: stalls an assigned task exactly at the threshold, with the rule', async () => {
  const s = rig()
  const { taskId } = s.assigned('assigned')
  await s.supervisor.tick(at(R.startup.afterMs - 1))
  expect(s.statusOf(taskId)).toBe('assigned')
  await s.supervisor.tick(at(R.startup.afterMs))
  expect(s.statusOf(taskId)).toBe('stalled')
  expect(s.lastRule(taskId)).toBe('startup')
})

test('startup: a signal since started spares the task', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('assigned')
  s.store.touchSignal(assignmentId, 'x', T0 + 1)
  await s.supervisor.tick(at(R.startup.afterMs))
  expect(s.statusOf(taskId)).toBe('assigned')
})

test('heartbeat: nudges once per quiet spell, exactly at the threshold, no status change', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running')
  s.store.touchSignal(assignmentId, 'x', T0)
  await s.supervisor.tick(at(R.heartbeat.afterMs - 1))
  expect(s.fake.state.inputs).toEqual([])
  await s.supervisor.tick(at(R.heartbeat.afterMs))
  expect(s.fake.state.inputs).toHaveLength(1)
  expect(s.fake.state.inputs[0]).toContain(`title ${taskId}`)
  expect(s.fake.state.inputs[0]).toContain('10 minutes')
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.lastRule(taskId)).toBe('heartbeat')
  expect(s.store.timeline(taskId).at(-1)?.kind).toBe('work.assignment.nudge')
  await s.supervisor.tick(at(R.heartbeat.afterMs + 1000))
  expect(s.fake.state.inputs).toHaveLength(1)
  s.store.touchSignal(assignmentId, 'y', at(R.heartbeat.afterMs + 2000))
  await s.supervisor.tick(at(R.heartbeat.afterMs + 2000 + R.heartbeat.afterMs))
  expect(s.fake.state.inputs).toHaveLength(2)
})

test('a chat nudge goes through the chat port', async () => {
  const s = rig()
  const { assignmentId } = s.assigned('running', { channel: 'chat' })
  s.store.touchSignal(assignmentId, 'x', T0)
  await s.supervisor.tick(at(R.heartbeat.afterMs))
  expect(s.fake.state.chats).toHaveLength(1)
  expect(s.fake.state.inputs).toEqual([])
})

test('a nudge failure logs, marks nothing and does not stop the tick', async () => {
  const s = rig()
  const a = s.assigned('running', { nodeId: 'n-a' })
  const b = s.assigned('running', { nodeId: 'n-b', channel: 'chat' })
  s.store.touchSignal(a.assignmentId, 'x', T0)
  s.store.touchSignal(b.assignmentId, 'x', T0)
  s.fake.state.throwOnInput = true
  await s.supervisor.tick(at(R.heartbeat.afterMs))
  expect(s.store.getAssignment(a.assignmentId)?.nudgedAt).toBeNull()
  expect(s.fake.state.chats).toHaveLength(1)
})

test('a nudge that never started the agent is not marked as nudged', async () => {
  const s = rig()
  const a = s.assigned('running', { nodeId: 'n-a' })
  s.store.touchSignal(a.assignmentId, 'x', T0)
  s.fake.state.submitResult = { ok: false, reason: 'not_started', message: 'did not start' }
  await s.supervisor.tick(at(R.heartbeat.afterMs))
  expect(s.fake.state.inputs).toHaveLength(1)
  expect(s.store.getAssignment(a.assignmentId)?.nudgedAt).toBeNull()
})

test('stalled: stalls a quiet running task exactly at the threshold, with the rule', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running')
  s.store.touchSignal(assignmentId, 'x', T0)
  s.store.markNudged(assignmentId, T0 + 1)
  await s.supervisor.tick(at(R.stalled.afterMs - 1))
  expect(s.statusOf(taskId)).toBe('running')
  await s.supervisor.tick(at(R.stalled.afterMs))
  expect(s.statusOf(taskId)).toBe('stalled')
  expect(s.lastRule(taskId)).toBe('stalled')
})

test('waiting_input is never timed out', async () => {
  const s = rig()
  const { taskId } = s.assigned('waiting_input')
  await s.supervisor.tick(at(100 * R.stalled.afterMs))
  expect(s.statusOf(taskId)).toBe('waiting_input')
  expect(s.fake.state.inputs).toEqual([])
})

test('waiting_input is not exempt from the session-gone check', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('waiting_input')
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('waiting_input')
  s.fake.state.live = false
  await s.supervisor.tick(T0 + 1)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.lastRule(taskId)).toBe('vanished')
  expect(s.store.getAssignment(assignmentId)?.endReason).toBe(VANISHED_NO_RESPAWN)
})

test('a waiting_input chat whose node is gone takes the respawn path', async () => {
  const s = rig()
  const { assignmentId } = s.assigned('waiting_input', { channel: 'chat' })
  s.fake.state.chatGone = true
  await s.supervisor.tick(T0)
  expect(s.fake.state.chats).toHaveLength(1)
  expect(s.store.getAssignment(assignmentId)?.restarts).toBe(1)
})

test('a running chat turn is a live signal', async () => {
  const s = rig()
  const { taskId } = s.assigned('running', { channel: 'chat' })
  s.fake.state.busy = true
  await s.supervisor.tick(at(R.stalled.afterMs))
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.fake.state.chats).toEqual([])
})

test('terminal vanished: the server cannot relaunch it, so it fails with the reason', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running')
  s.fake.state.live = false
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.store.timeline(taskId).find((e) => e.to === 'failed')).toMatchObject({ rule: 'vanished', reason: VANISHED_NO_RESPAWN })
  expect(s.store.getAssignment(assignmentId)?.endReason).toBe(VANISHED_NO_RESPAWN)
})

test('spawn vanished: terminal agent row fails with the reason; live row does not', async () => {
  const s = rig()
  const { taskId } = s.assigned('running', { channel: 'spawn', agentId: 'ag' })
  s.fake.state.agents.ag = { state: 'working', endReason: null }
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('running')
  s.fake.state.agents.ag = { state: 'session_exited', endReason: 'pty_exit' }
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.store.timeline(taskId).find((e) => e.to === 'failed')?.reason).toBe(VANISHED_NO_RESPAWN)
})

test('an approval_pending spawn is skipped entirely', async () => {
  const s = rig()
  const { taskId } = s.assigned('assigned', { channel: 'spawn', agentId: 'ag' })
  s.fake.state.agents.ag = { state: 'approval_pending', endReason: null }
  await s.supervisor.tick(at(100 * R.stalled.afterMs))
  expect(s.statusOf(taskId)).toBe('assigned')
})

test('a cancelled spawn fails the task with the end reason', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('assigned', { channel: 'spawn', agentId: 'ag' })
  s.fake.state.agents.ag = { state: 'cancelled', endReason: 'rejected' }
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.store.getAssignment(assignmentId)?.endReason).toBe('rejected')
})

test('chat vanished: respawns once, then fails with rule vanished', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running', { channel: 'chat' })
  s.fake.state.chatGone = true
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.fake.state.chats).toHaveLength(1)
  expect(s.store.getAssignment(assignmentId)?.restarts).toBe(1)
  expect(s.store.timeline(taskId).at(-1)).toMatchObject({ kind: 'work.assignment.respawn', rule: 'vanished' })
  await s.supervisor.tick(T0 + 1)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.lastRule(taskId)).toBe('vanished')
  expect(s.fake.state.chats).toHaveLength(1)
})

test('chat respawn the port refuses fails the task and names the code', async () => {
  const s = rig()
  const { taskId } = s.assigned('running', { channel: 'chat' })
  s.fake.state.chatGone = true
  s.fake.state.chatResult = { ok: false, code: 'node_not_found' }
  await s.supervisor.tick(T0)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.store.timeline(taskId).find((e) => e.to === 'failed')?.reason).toBe('vanished: node_not_found')
})

test('restart limit: a third respawn of a task within the hour fails it, later it is allowed again', async () => {
  const s = rig()
  const { taskId } = s.assigned('running', { channel: 'chat' })
  s.fake.state.chatGone = true
  const reassign = () => {
    const open = s.store.openAssignmentOfTask(taskId)
    if (open) s.store.endAssignment(open.id, 'test')
    s.db.query("UPDATE central_task SET status = 'todo' WHERE id = ?").run(taskId)
    s.store.openAssignment({ taskId, nodeId: 'node-1', channel: 'chat', instruction: 'again', actor: { kind: 'central' } })
    s.db.query("UPDATE central_task SET status = 'running' WHERE id = ?").run(taskId)
  }
  await s.supervisor.tick(T0)
  reassign()
  await s.supervisor.tick(T0 + 1)
  reassign()
  await s.supervisor.tick(T0 + 2)
  expect(s.statusOf(taskId)).toBe('failed')
  expect(s.lastRule(taskId)).toBe('restart_limit')
  expect(s.fake.state.chats).toHaveLength(2)
})

test('sessionEnded on a chat respawns even with the node present', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running', { channel: 'chat' })
  const a = s.store.getAssignment(assignmentId)
  if (a) await s.supervisor.sessionEnded(a, 'agentChat.closed')
  expect(s.fake.state.chats).toHaveLength(1)
  expect(s.statusOf(taskId)).toBe('running')
})

test('sessionEnded on a terminal still live waits for the PTY to really end', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running')
  const a = s.store.getAssignment(assignmentId)
  if (a) await s.supervisor.sessionEnded(a, 'hook.SessionEnd')
  expect(s.statusOf(taskId)).toBe('running')
  s.fake.state.live = false
  if (a) await s.supervisor.sessionEnded(a, 'pty.exit')
  expect(s.statusOf(taskId)).toBe('failed')
})

test('a throwing store does not kill the tick', async () => {
  const s = rig()
  const bad = s.assigned('assigned', { nodeId: 'n-bad' })
  const good = s.assigned('assigned', { nodeId: 'n-good' })
  const realGet = s.store.getTask
  const store: WorkStore = { ...s.store, getTask: (id) => { if (id === bad.taskId) throw new Error('db locked'); return realGet(id) } }
  const sup = createWorkSupervisor({ store, ports: s.fake.ports, now: s.now })
  await sup.tick(at(R.startup.afterMs))
  expect(s.statusOf(good.taskId)).toBe('stalled')
  const broken: WorkStore = { ...s.store, openAssignments: () => { throw new Error('db gone') } }
  await createWorkSupervisor({ store: broken, ports: s.fake.ports, now: s.now }).tick(T0)
})

test('finishTask moves the task, ends the open assignment and records both', () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('needs_review')
  finishTask(s.store, taskId, 'cancelled', { actor: { kind: 'human' }, reason: 'not needed' })
  expect(s.statusOf(taskId)).toBe('cancelled')
  expect(s.store.getAssignment(assignmentId)?.endReason).toBe('not needed')
  expect(s.store.openAssignmentOfTask(taskId)).toBeNull()
  const none = s.assigned('needs_review', { nodeId: 'n2' })
  s.store.endAssignment(none.assignmentId, 'session_end')
  expect(finishTask(s.store, none.taskId, 'done', { actor: { kind: 'human' } }).status).toBe('done')
})
