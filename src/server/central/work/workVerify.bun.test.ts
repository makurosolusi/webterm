import { expect, test } from 'bun:test'
import type { CompletionVerdict } from '../../verifier/verifier.judge'
import type { VerifyDirOptions } from '../../verifier/verifier.checks'
import { createWorkVerifier } from './workVerify'
import { rig } from './workRig.testutil'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const verdict = (status: 'done' | 'failed'): CompletionVerdict => ({ status, reason: status === 'done' ? 'verified' : 'tests_failed', message: 'm', summary: status === 'done' ? '1 file, tests green' : 'failed: tests', filesChanged: ['a.ts'], leaseViolations: [] } as unknown as CompletionVerdict)

/** A check whose completion the test controls. */
function gate() {
  const calls: { cwd: string; opts: VerifyDirOptions; resolve(v: CompletionVerdict): void; reject(e: unknown): void }[] = []
  const check = (cwd: string, opts: VerifyDirOptions) => new Promise<CompletionVerdict>((resolve, reject) => { calls.push({ cwd, opts, resolve, reject }) })
  return { calls, check }
}

function setup(autoDone?: (projectId: string) => boolean) {
  const r = rig()
  const g = gate()
  const verifier = createWorkVerifier({ store: r.store, now: r.now, cwdOf: () => '/tmp/p1', check: g.check, ...(autoDone ? { autoDone } : {}) })
  return { ...r, ...g, verifier }
}

test('review acceptance goes straight to needs_review', async () => {
  const s = setup()
  const { taskId } = s.assigned('reported')
  await s.verifier.run(taskId)
  expect(s.statusOf(taskId)).toBe('needs_review')
  expect(s.calls).toEqual([])
  expect(s.lastRule(taskId)).toBe('acceptance_review')
})

test('a task not reported is left alone', async () => {
  const s = setup()
  const { taskId } = s.assigned('running', { acceptance: 'project_checks' })
  await s.verifier.run(taskId)
  expect(s.statusOf(taskId)).toBe('running')
})

for (const [status, rule, passed] of [['done', 'verify_passed', true], ['failed', 'verify_failed', false]] as const) {
  test(`project_checks ${status}: lands in needs_review with the verdict stored`, async () => {
    const s = setup()
    const { taskId } = s.assigned('reported', { acceptance: 'project_checks' })
    const running = s.verifier.run(taskId)
    expect(s.statusOf(taskId)).toBe('verifying')
    await settle()
    expect(s.calls[0]).toMatchObject({ cwd: '/tmp/p1', opts: { taskId } })
    s.calls[0]?.resolve(verdict(status))
    await running
    expect(s.statusOf(taskId)).toBe('needs_review')
    expect(s.lastRule(taskId)).toBe(rule)
    expect(s.store.getTask(taskId)?.verification).toMatchObject({ passed, status, filesChanged: ['a.ts'] })
  })
}

test('a verifier crash lands in needs_review with the error recorded', async () => {
  const s = setup()
  const { taskId } = s.assigned('reported', { acceptance: 'project_checks' })
  const running = s.verifier.run(taskId)
  await settle()
  s.calls[0]?.reject(new Error('spawn ENOENT'))
  await running
  expect(s.statusOf(taskId)).toBe('needs_review')
  expect(s.lastRule(taskId)).toBe('verify_crashed')
  expect(s.store.getTask(taskId)?.verification).toMatchObject({ passed: false, error: 'spawn ENOENT' })
})

test('a project with no directory is a recorded crash', async () => {
  const r = rig()
  const verifier = createWorkVerifier({ store: r.store, now: r.now, cwdOf: () => null })
  const { taskId } = r.assigned('reported', { acceptance: 'project_checks' })
  await verifier.run(taskId)
  expect(r.statusOf(taskId)).toBe('needs_review')
  expect(r.store.getTask(taskId)?.verification).toMatchObject({ passed: false })
})

test('a stale result after the task moved on is dropped', async () => {
  const s = setup()
  const { taskId } = s.assigned('reported', { acceptance: 'project_checks' })
  const running = s.verifier.run(taskId)
  await settle()
  s.store.moveTask(taskId, 'running', { actor: { kind: 'system' }, rule: 'activity' })
  s.calls[0]?.resolve(verdict('done'))
  await running
  expect(s.statusOf(taskId)).toBe('running')
  expect(s.store.getTask(taskId)?.verification).toBeNull()
})

test('a late result of an earlier run cannot land on a re-verification', async () => {
  const s = setup()
  const { taskId } = s.assigned('reported', { acceptance: 'project_checks' })
  const first = s.verifier.run(taskId)
  await settle()
  s.store.moveTask(taskId, 'running', { actor: { kind: 'system' } })
  s.store.moveTask(taskId, 'reported', { actor: { kind: 'system' } })
  const second = s.verifier.run(taskId)
  s.calls[0]?.resolve(verdict('done'))
  await first
  expect(s.statusOf(taskId)).toBe('verifying')
  expect(s.store.getTask(taskId)?.verification).toBeNull()
  await settle()
  s.calls[1]?.resolve(verdict('failed'))
  await second
  expect(s.store.getTask(taskId)?.verification).toMatchObject({ passed: false })
})

test('at most one check at a time per project', async () => {
  const s = setup()
  const a = s.assigned('reported', { acceptance: 'project_checks', nodeId: 'n-a' })
  const b = s.assigned('reported', { acceptance: 'project_checks', nodeId: 'n-b' })
  const ra = s.verifier.run(a.taskId)
  const rb = s.verifier.run(b.taskId)
  await settle()
  expect(s.calls).toHaveLength(1)
  s.calls[0]?.resolve(verdict('done'))
  await ra
  await settle()
  expect(s.calls).toHaveLength(2)
  s.calls[1]?.resolve(verdict('done'))
  await rb
  expect([s.statusOf(a.taskId), s.statusOf(b.taskId)]).toEqual(['needs_review', 'needs_review'])
})

test('autoDone off by default: a pass stays in needs_review', async () => {
  const s = setup()
  const { taskId } = s.assigned('reported', { acceptance: 'project_checks' })
  const running = s.verifier.run(taskId)
  await settle()
  s.calls[0]?.resolve(verdict('done'))
  await running
  expect(s.statusOf(taskId)).toBe('needs_review')
})

test('autoDone on: a pass is done with rule auto_done and the assignment ends', async () => {
  const s = setup(() => true)
  const { taskId, assignmentId } = s.assigned('reported', { acceptance: 'project_checks' })
  const running = s.verifier.run(taskId)
  await settle()
  s.calls[0]?.resolve(verdict('done'))
  await running
  expect(s.statusOf(taskId)).toBe('done')
  expect(s.lastRule(taskId)).toBe('auto_done')
  expect(s.store.getAssignment(assignmentId)?.endReason).toBe('auto_done')
})

test('autoDone on: a failure is never done', async () => {
  const s = setup(() => true)
  const { taskId } = s.assigned('reported', { acceptance: 'project_checks' })
  const running = s.verifier.run(taskId)
  await settle()
  s.calls[0]?.resolve(verdict('failed'))
  await running
  expect(s.statusOf(taskId)).toBe('needs_review')
})
