import { expect, test } from 'bun:test'
import { startWorkWatcher } from './workWatcher'
import { settleExecTask } from './workLifecycle'
import { buildResult, noResult, RESULT_MAX_BYTES, stashStopResult } from './workResult'
import { event, NODE, rig } from './workRig.testutil'

function setup() {
  const r = rig()
  const off = startWorkWatcher({ store: r.store, now: r.now, bus: r.bus, onReported: () => {}, onSessionEnded: () => {} })
  const resultOf = (id: string) => r.store.assignmentsOfTask(id)[0]?.result as { source: string; text: string; reason?: string; hash: string; at: number; failure?: unknown } | null
  return { ...r, off, resultOf }
}

test('POLICY: every Stop that reaches reported leaves a result or an explicit none with a reason', () => {
  const cases: Array<() => void> = [() => stashStopResult(NODE, buildResult('stop_hook', 'done', 1)), () => stashStopResult(NODE, noResult('transcript_unreadable', 1)), () => {}]
  for (const park of cases) {
    const s = setup()
    const { taskId } = s.assigned('running')
    park()
    s.bus.publish(event('hook.Stop'))
    expect(s.statusOf(taskId)).toBe('reported')
    const res = s.resultOf(taskId)
    expect(res).not.toBeNull()
    expect(res?.source === 'none' ? (res.reason ?? '').length > 0 : res?.text.length).toBeTruthy()
  }
})

test('a chat turn_end report (no hook payload) is recorded as none with a reason', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  s.bus.publish(event('agentChat.turn_end', { outcome: 'ok' }))
  expect(s.resultOf(taskId)).toMatchObject({ source: 'none', reason: 'no_hook_payload:agentChat.turn_end' })
})

test('Stop stores the parked message on the assignment', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  stashStopResult(NODE, buildResult('stop_hook', 'work\nRESULT: shipped', 5))
  s.bus.publish(event('hook.Stop'))
  expect(s.resultOf(taskId)).toMatchObject({ source: 'stop_hook', resultLine: 'shipped' })
})

test('StopFailure is stored as a failure reason, not as a result', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  stashStopResult(NODE, noResult('stop_failure', 5, { error: 'rate_limit' }))
  s.bus.publish(event('hook.StopFailure'))
  expect(s.statusOf(taskId)).toBe('stalled')
  expect(s.resultOf(taskId)).toMatchObject({ source: 'none', text: '', failure: { error: 'rate_limit' } })
})

test('SubagentStop moves nothing and stores nothing', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  s.bus.publish(event('hook.SubagentStop', { subagent: true }))
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.resultOf(taskId)).toBeNull()
})

test('redaction happens on write and the text is capped with a truncated flag', () => {
  const secret = 'sk-ant-api03-' + 'B'.repeat(40)
  const r = buildResult('stop_hook', `${secret} ${'y'.repeat(RESULT_MAX_BYTES * 2)}`, 1)
  expect(r.text).not.toContain(secret)
  expect(r.truncated).toBe(true)
  expect(Buffer.byteLength(r.text) <= RESULT_MAX_BYTES).toBe(true)
})

test('a resumed session re-sending the same Stop does not overwrite or duplicate the result', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  stashStopResult(NODE, buildResult('stop_hook', 'same message', 100))
  s.bus.publish(event('hook.Stop'))
  s.bus.publish(event('hook.UserPromptSubmit'))
  s.clock.t += 5000
  stashStopResult(NODE, buildResult('stop_hook', 'same message', s.clock.t))
  s.bus.publish(event('hook.Stop'))
  expect(s.statusOf(taskId)).toBe('reported')
  expect(s.resultOf(taskId)?.at).toBe(100)
})

test('a different later message replaces the result', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  stashStopResult(NODE, buildResult('stop_hook', 'first', 1))
  s.bus.publish(event('hook.Stop'))
  s.bus.publish(event('hook.UserPromptSubmit'))
  stashStopResult(NODE, buildResult('stop_hook', 'second', 2))
  s.bus.publish(event('hook.Stop'))
  expect(s.resultOf(taskId)?.text).toBe('second')
})

test('ending the assignment keeps the captured result', () => {
  const s = setup()
  const { taskId, assignmentId } = s.assigned('running')
  stashStopResult(NODE, buildResult('stop_hook', 'kept', 1))
  s.bus.publish(event('hook.Stop'))
  s.store.endAssignment(assignmentId, 'done')
  expect(s.resultOf(taskId)?.text).toBe('kept')
})

test('a headless exit stores its output tail', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  settleExecTask(s.db, s.now, NODE, { ok: true, reason: 'exec_exit_0', tail: 'log\nRESULT: ok' })
  expect(s.statusOf(taskId)).toBe('reported')
  expect(s.resultOf(taskId)).toMatchObject({ source: 'exec_tail', resultLine: 'ok' })
})
