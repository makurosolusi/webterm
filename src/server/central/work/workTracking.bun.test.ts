import { afterEach, expect, test } from 'bun:test'
import { eventBus } from '../../events/eventBus'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { CompletionVerdict } from '../../verifier/verifier.judge'
import { createWorkTracking } from './workTracking'
import { event, rig } from './workRig.testutil'

const sessions = { isLive: () => true, input: () => {} } as unknown as WorkerSessionPort // test-only
const PASS = { status: 'done', reason: 'verified', message: 'm', summary: 'green', filesChanged: [], leaseViolations: [] } as unknown as CompletionVerdict // test-only
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let stops: (() => void)[] = []
afterEach(() => { stops.forEach((stop) => stop()); stops = [] })

function setup() {
  const r = rig()
  let finish: (v: CompletionVerdict) => void = () => {}
  const check = () => new Promise<CompletionVerdict>((resolve) => { finish = resolve })
  const tracking = createWorkTracking({ db: r.db, sessions, now: r.now, noTimer: true, check })
  const start = () => { const stop = tracking.start(); stops.push(stop); return stop }
  return { ...r, start, finish: (v: CompletionVerdict) => finish(v) }
}

test('start moves a verifying task with no verification running to needs_review, once', () => {
  const s = setup()
  const { taskId, assignmentId } = s.assigned('verifying', { acceptance: 'project_checks' })
  s.start()()
  expect(s.statusOf(taskId)).toBe('needs_review')
  expect(s.lastRule(taskId)).toBe('verifier_interrupted')
  expect(s.store.getTask(taskId)?.verification).toMatchObject({ passed: false, interrupted: true })
  expect(s.store.getAssignment(assignmentId)?.endedAt).toBeNull()
  s.start()()
  expect(s.store.timeline(taskId).filter((e) => e.rule === 'verifier_interrupted')).toHaveLength(1)
})

test('a bounce does not touch a verification still running, and its verdict still lands', async () => {
  const s = setup()
  const { taskId } = s.assigned('running', { acceptance: 'project_checks' })
  const stop = s.start()
  eventBus.publish(event('hook.Stop'))
  await settle()
  expect(s.statusOf(taskId)).toBe('verifying')
  stop()
  s.start()
  expect(s.statusOf(taskId)).toBe('verifying')
  expect(s.store.timeline(taskId).filter((e) => e.rule === 'verifier_interrupted')).toHaveLength(0)
  s.finish(PASS)
  await settle()
  expect(s.statusOf(taskId)).toBe('needs_review')
  expect(s.lastRule(taskId)).toBe('verify_passed')
  expect(s.store.getTask(taskId)?.verification).toMatchObject({ passed: true })
})

test('recovery reaches past one page of verifying tasks', () => {
  const s = setup()
  const ids = Array.from({ length: 205 }, (_, i) => s.assigned('verifying', { nodeId: `n-${i}` }).taskId)
  s.start()()
  expect(ids.filter((id) => s.statusOf(id) !== 'needs_review')).toEqual([])
})
