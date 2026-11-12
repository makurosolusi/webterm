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

// Event-driven ends and the PTY finish path: a real agent store on the same db, no tick and no timer.
const { createAgentStore } = await import('../agents/agentStore')
const { startAgentPtyWatcher } = await import('../agents/agentPtyWatcher')

function withAgent(s: ReturnType<typeof setup>, status: 'assigned' | 'running') {
  const agents = createAgentStore(s.db, s.now)
  agents.create({ id: 'ag-1', projectId: 'p1', kind: 'claude', role: 'worker', runner: 'pty', owner: 'central:c', reqId: 'r1', taskId: 'x' })
  for (const to of ['provisioning', 'starting', 'working'] as const) agents.transition('ag-1', to, to === 'working' ? { nodeId: 'c-ag-1' } : {})
  const { taskId } = s.assigned(status, { channel: 'spawn', agentId: 'ag-1', nodeId: 'c-ag-1', acceptance: 'review' })
  return { agents, taskId }
}

test('an agent that ends (spawn failure, exit, cancel) fails its task at once, with no tick', async () => {
  const s = setup()
  s.start()
  const { agents, taskId } = withAgent(s, 'running')
  agents.transition('ag-1', 'failed', { reason: 'spawn_failed:runner' })
  await settle()
  expect(s.statusOf(taskId)).toBe('failed')
  // The move queued a wake that is due now, so the check-in pass sends it without the 5-minute window.
  const wake = s.db.query("SELECT kind, not_before AS notBefore, created_at AS createdAt FROM central_checkin_reason WHERE dedupe_key LIKE 'wake:%'").get() as { kind: string; notBefore: number; createdAt: number } | null
  expect(wake?.kind).toBe('task_failed')
  expect(Number(wake?.notBefore) <= s.now()).toBe(true)
})

test('a PTY agent that finishes its turn reaches reported, then needs_review, and stays promptable (candidate_done)', async () => {
  const s = setup()
  s.start()
  const { agents, taskId } = withAgent(s, 'running')
  const stopPty = startAgentPtyWatcher({ db: s.db, store: agents, now: s.now, bus: eventBus })
  stops.push(stopPty)
  eventBus.publish(event('hook.Stop', {}, 'c-ag-1'))
  await settle()
  expect(s.store.timeline(taskId).map((e) => e.to).filter(Boolean)).toEqual(expect.arrayContaining(['reported', 'needs_review']))
  expect(s.statusOf(taskId)).toBe('needs_review')
  expect(agents.get('ag-1')?.state).toBe('candidate_done')
})
