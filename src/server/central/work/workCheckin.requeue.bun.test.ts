// Root-lock: a check-in whose turn died on the network gets its reason back (same row, no second wake), at most
// three times, only while the task made no progress, and never for a class a human must fix.
import { expect, test } from 'bun:test'
import { queueCheckinReason } from './workCheckin'
import { REQUEUE_EVENT } from './workRecover.model'
import { MIN, T0, recoverRig } from './workRecover.testutil'

/** A running task whose wake was sent at T0+1min in turn `turn1`, which failed at T0+2min with `kind` in its error part. */
function lostWake(kind: string | null, code = 'runtime_error') {
  const s = recoverRig()
  s.outage()
  const { taskId } = s.assigned('running')
  queueCheckinReason(s.db, { kind: 'task_failed', dedupeKey: 'k1', projectId: 'p1', taskId, text: 'task failed', now: T0 })
  const send = (): void => { s.db.query("UPDATE central_checkin_reason SET sent_at = ?, turn_id = 'turn1' WHERE dedupe_key = 'k1'").run(T0 + MIN) }
  send()
  s.db.query("INSERT INTO central_turn (id, conversation_id, message_id, status, error_code, started_at, ended_at) VALUES ('turn1', 'c', 'm1', 'failed', ?, ?, ?)").run(code, T0 + MIN, T0 + 2 * MIN)
  const parts = JSON.stringify(kind ? [{ type: 'error', code, message: 'x', kind }] : [{ type: 'error', code, message: 'x' }])
  s.db.query("INSERT INTO central_message (id, conversation_id, seq, role, parts_json, turn_id, created_at) VALUES ('m2', 'c', 1, 'assistant', ?, 'turn1', ?)").run(parts, T0 + 2 * MIN)
  s.setNow(T0 + 11 * MIN)
  const reason = () => s.reasons().find((r) => r.dedupe_key === 'k1') as Record<string, unknown>
  return { s, taskId, send, reason }
}

test('a wake whose turn died on the network is queued again: same row, sent_at and turn_id cleared, audit kept', async () => {
  const { s, taskId, reason } = lostWake('network')
  await s.recover.sweep(s.key())
  expect(reason().sent_at).toBeNull()
  expect(reason().turn_id).toBeNull()
  expect(s.reasons().length).toBe(1)
  expect(s.finalOf(taskId)).toMatchObject({ outcome: 'rescheduled', reason: 'checkin_requeued:1' })
  expect(s.count(REQUEUE_EVENT)).toBe(1)
  expect(s.announced[0]?.text).toContain('1 task affected: 1 waiting to retry')
})

test('at most three requeues, then a human is told once; the wake is never doubled', async () => {
  const { s, taskId, send, reason } = lostWake('overloaded')
  await s.recover.sweep(s.key())
  for (let i = 0; i < 4; i += 1) { send(); await s.recover.sweep(s.key(), true) }
  expect(s.count(REQUEUE_EVENT)).toBe(3)
  expect(reason().sent_at).not.toBeNull()
  expect(s.finalOf(taskId)).toMatchObject({ outcome: 'escalated', reason: 'limit:checkin_requeue' })
  // The original reason plus exactly one escalation reason.
  expect(s.reasons().length).toBe(2)
})

test('a task that moved after the wake was sent is not a victim: the wake did its job', async () => {
  const { s, taskId, reason } = lostWake('network')
  s.setNow(T0 + 5 * MIN)
  s.store.moveTask(taskId, 'waiting_input', { actor: { kind: 'system' }, rule: 'needs_input' })
  s.setNow(T0 + 11 * MIN)
  await s.recover.sweep(s.key())
  expect(reason().sent_at).not.toBeNull()
  expect(s.count(REQUEUE_EVENT)).toBe(0)
})

test('auth and permanent failures are never queued again', async () => {
  for (const kind of ['auth', 'permanent']) {
    const { s, taskId, reason } = lostWake(kind)
    await s.recover.sweep(s.key())
    expect(reason().sent_at).not.toBeNull()
    expect(s.finalOf(taskId)).toMatchObject({ outcome: 'escalated', reason: `needs_human:${kind}` })
    expect(s.count(REQUEUE_EVENT)).toBe(0)
  }
})

test('a turn cut by a server restart (interrupted, no class) inside the window counts as a network loss', async () => {
  const { s, reason } = lostWake(null, 'interrupted')
  await s.recover.sweep(s.key())
  expect(reason().sent_at).toBeNull()
})

test('a failed turn with an unknown class is left alone: nothing proves the link did it', async () => {
  const { s, reason } = lostWake(null)
  await s.recover.sweep(s.key())
  expect(reason().sent_at).not.toBeNull()
})
