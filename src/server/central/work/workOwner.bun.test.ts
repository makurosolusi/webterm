// Root-locking tests of the owner/lease invariant: every open status has exactly one derived owner and a stored lease,
// whichever transition got it there, and a restart does not make old leases fire at once.
import { expect, test } from 'bun:test'
import { canWorkTransition, WORK_STATUSES, type WorkStatus } from '../../../shared/centralWork'
import { WORK_SIGNAL_MOVES } from './workWatcher'
import { BOOT_GRACE_MS, LEASE_MS, leaseFor, OPEN_STATUSES, ownerOf } from './workOwner'
import { createWorkSupervisor } from './workSupervisor'
import { rig, T0 } from './workRig.testutil'

const HOUR_MS = 3_600_000

test('policy: ownerOf and a lease window exist for exactly the open statuses', () => {
  expect([...OPEN_STATUSES].sort()).toEqual(['assigned', 'failed', 'needs_review', 'reported', 'running', 'stalled', 'verifying', 'waiting_input'])
  for (const status of WORK_STATUSES) {
    const open = OPEN_STATUSES.includes(status)
    expect(ownerOf(status) !== null).toBe(open)
    expect(leaseFor(status, T0) !== null).toBe(open)
  }
  expect(OPEN_STATUSES.map((s) => ownerOf(s))).toEqual(['agent', 'agent', 'central', 'central', 'central', 'verifier', 'verifier', 'human'])
})

test('property: every legal move into an open status leaves the task with its owner and a fresh stored lease', () => {
  const s = rig()
  const fromTo = WORK_STATUSES.flatMap((from) => WORK_STATUSES.filter((to) => canWorkTransition(from, to) && OPEN_STATUSES.includes(to) && OPEN_STATUSES.includes(from)).map((to) => [from, to] as const))
  // The signal, verifier and report moves are all among these edges.
  const named = [...Object.values(WORK_SIGNAL_MOVES).flatMap((m) => m.from.map((from) => [from, m.to] as const)), ['reported', 'verifying'], ['reported', 'needs_review'], ['verifying', 'needs_review'], ['running', 'reported'], ['running', 'waiting_input']] as const
  // The watcher takes `assigned -> waiting_input` in two hops (via running), so only legal single edges are asserted.
  for (const edge of named.filter(([f, t]) => canWorkTransition(f, t))) expect(fromTo.some(([f, t]) => f === edge[0] && t === edge[1])).toBe(true)
  expect(fromTo.length).toBeGreaterThan(10)
  for (const [from, to] of fromTo) {
    const { taskId, assignmentId } = s.assigned(from as WorkStatus)
    s.db.query('UPDATE central_assignment SET lease_until = NULL WHERE id = ?').run(assignmentId)
    s.clock.t = T0 + 5000
    const moved = s.store.moveTask(taskId, to, { actor: { kind: 'system' }, assignmentId })
    expect(moved.owner).toBe(ownerOf(to))
    expect(s.store.getAssignment(assignmentId)?.leaseUntil).toBe(leaseFor(to, T0 + 5000))
  }
})

test('a signal renews the lease of an agent-owned task only', () => {
  const s = rig()
  const run = s.assigned('running')
  const rev = s.assigned('needs_review', { nodeId: 'n-2' })
  s.db.query('UPDATE central_assignment SET lease_until = 7 WHERE id = ?').run(rev.assignmentId)
  s.store.touchSignal(run.assignmentId, 'x', T0 + 1000)
  s.store.touchSignal(rev.assignmentId, 'x', T0 + 1000)
  expect(s.store.getAssignment(run.assignmentId)?.leaseUntil).toBe(T0 + 1000 + LEASE_MS.agentActive)
  expect(s.store.getAssignment(rev.assignmentId)?.leaseUntil).toBe(7)
})

test('restart: the lease is stored, and an old assignment gets one grace cycle before it is stalled', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running')
  s.store.touchSignal(assignmentId, 'x', T0)
  // The agent went quiet an hour ago and the server was down since; a fresh process starts with a new supervisor.
  const reboot = T0 + HOUR_MS
  const fresh = createWorkSupervisor({ store: s.store, ports: s.fake.ports, now: () => reboot })
  expect(s.store.getAssignment(assignmentId)?.leaseUntil).toBe(T0 + LEASE_MS.agentActive)
  await fresh.tick(reboot)
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.store.getAssignment(assignmentId)?.leaseUntil).toBe(reboot + BOOT_GRACE_MS)
  await fresh.tick(reboot + BOOT_GRACE_MS - 1)
  expect(s.statusOf(taskId)).toBe('running')
  await fresh.tick(reboot + BOOT_GRACE_MS)
  expect(s.statusOf(taskId)).toBe('stalled')
  expect(s.lastRule(taskId)).toBe('stalled')
})

test('restart: a signal during the grace renews the lease and the task is spared', async () => {
  const s = rig()
  const { taskId, assignmentId } = s.assigned('running')
  const reboot = T0 + HOUR_MS
  const fresh = createWorkSupervisor({ store: s.store, ports: s.fake.ports, now: () => reboot })
  await fresh.tick(reboot)
  s.store.touchSignal(assignmentId, 'x', reboot + 1000)
  await fresh.tick(reboot + BOOT_GRACE_MS)
  expect(s.statusOf(taskId)).toBe('running')
})
