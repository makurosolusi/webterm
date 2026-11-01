import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPS } from './caps'
import { PROJECT, REPO, item, planOf, setup, worker } from './orchestrator.fake.testutil'

async function assigned() {
  const ctx = setup(planOf([item()]))
  const assignedPlan = ctx.orchestrator.assignTask({
    projectId: PROJECT,
    itemId: 'i1',
    assignee: 'w1',
    expectedVersion: 1,
  })
  if (!assignedPlan.ok) throw new Error('assign failed')
  return { ...ctx, version: assignedPlan.value.plan.version, taskId: assignedPlan.value.task.id }
}

async function started() {
  const ctx = await assigned()
  const s = await ctx.orchestrator.startWorker({
    projectId: PROJECT,
    itemId: 'i1',
    expectedVersion: ctx.version,
    repo: REPO,
  })
  if (!s.ok) throw new Error(`start failed: ${s.code}`)
  return { ...ctx, taskId: s.value.task.id, fence: s.value.task.fence, version: s.value.plan.version }
}

describe('startWorker', () => {
  it('allocates a worktree, leases the task, and marks the item running', async () => {
    const ctx = await assigned()
    const result = await ctx.orchestrator.startWorker({
      projectId: PROJECT,
      itemId: 'i1',
      expectedVersion: ctx.version,
      repo: REPO,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.task.status).toBe('leased')
    expect(result.value.task.fence).toBe(1)
    expect(result.value.task.leaseOwner).toBe('w1')
    expect(result.value.worktree.branch).toBe(`agent/${ctx.taskId}`)
    expect(ctx.worktrees.allocations.length).toBe(1)
    expect(result.value.item.status).toBe('running')
    expect(result.value.plan.version).toBe(3)
  })

  it('denies the fourth concurrent worker before touching ledger or worktree', async () => {
    const running = [0, 1, 2].map((index) =>
      item({ id: `r${index}`, taskId: `tr${index}`, status: 'running', assignee: 'w1' })
    )
    const ctx = setup(planOf([...running, item({ id: 'i4', seq: 3 })]), [worker('w1')])
    const assignedPlan = ctx.orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i4',
      assignee: 'w1',
      expectedVersion: 1,
    })
    if (!assignedPlan.ok) throw new Error('assign failed')
    const result = await ctx.orchestrator.startWorker({
      projectId: PROJECT,
      itemId: 'i4',
      expectedVersion: assignedPlan.value.plan.version,
      repo: REPO,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('cap_denied')
    expect(result.violations?.[0]?.code).toBe('parallel_workers')
    expect(ctx.worktrees.allocations.length).toBe(0)
    expect(ctx.ledger.tasks.get(assignedPlan.value.task.id)?.status).toBe('pending')
  })

  it('denies a task that already burned its attempts', async () => {
    const ctx = await assigned()
    const task = ctx.ledger.tasks.get(ctx.taskId)
    if (task) task.attempt = DEFAULT_CAPS.maxAttemptsPerTask
    const result = await ctx.orchestrator.startWorker({
      projectId: PROJECT,
      itemId: 'i1',
      expectedVersion: ctx.version,
      repo: REPO,
    })
    expect(result.ok === false && result.code).toBe('cap_denied')
    expect(result.ok === false && result.violations?.[0]?.code).toBe('attempts')
  })

  it('denies a worktree failure without leasing', async () => {
    const ctx = await assigned()
    ctx.worktrees.failAllocate = true
    const result = await ctx.orchestrator.startWorker({
      projectId: PROJECT,
      itemId: 'i1',
      expectedVersion: ctx.version,
      repo: REPO,
    })
    expect(result.ok === false && result.code).toBe('worktree_failed')
    expect(ctx.ledger.tasks.get(ctx.taskId)?.status).toBe('pending')
  })

  it('releases the worktree when the lease cannot be taken', async () => {
    const ctx = await assigned()
    ctx.ledger.leaseFails = true
    const result = await ctx.orchestrator.startWorker({
      projectId: PROJECT,
      itemId: 'i1',
      expectedVersion: ctx.version,
      repo: REPO,
    })
    expect(result.ok === false && result.code).toBe('lease_denied')
    expect(ctx.worktrees.releases).toEqual([ctx.taskId])
    expect(ctx.worktrees.allocations.length).toBe(0)
  })

  it('refuses to start an item that was never assigned', async () => {
    const ctx = setup(planOf([item()]))
    const result = await ctx.orchestrator.startWorker({
      projectId: PROJECT,
      itemId: 'i1',
      expectedVersion: 1,
      repo: REPO,
    })
    expect(result.ok === false && result.code).toBe('invalid_state')
  })
})

describe('recordWorkerResult', () => {
  it('verifies a result that carries passing tests and typecheck', async () => {
    const ctx = await started()
    const result = await ctx.orchestrator.recordWorkerResult({
      projectId: PROJECT,
      taskId: ctx.taskId,
      fence: ctx.fence,
      actor: 'w1',
      outcome: 'success',
      expectedVersion: ctx.version,
      evidence: { tests: { passed: 12, failed: 0, command: 'bun test' }, typecheck: { ok: true } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verified).toBe(true)
    expect(result.value.task.status).toBe('verified')
    expect(result.value.item.status).toBe('done')
    expect(ctx.worktrees.releases).toEqual([ctx.taskId])
  })

  it('leaves evidence without tests at claimed_done, not verified', async () => {
    const ctx = await started()
    const result = await ctx.orchestrator.recordWorkerResult({
      projectId: PROJECT,
      taskId: ctx.taskId,
      fence: ctx.fence,
      actor: 'w1',
      outcome: 'success',
      expectedVersion: ctx.version,
      evidence: { filesChanged: ['src/api.ts'] },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.verified).toBe(false)
    expect(result.value.task.status).toBe('claimed_done')
    expect(result.value.item.status).toBe('running')
  })

  it('does not verify when tests failed or a scope violation was reported', async () => {
    for (const evidence of [
      { tests: { passed: 3, failed: 1 } },
      { tests: { passed: 3, failed: 0 }, scopeViolations: ['src/other.ts'] },
      { tests: { passed: 0, failed: 0 } },
    ]) {
      const ctx = await started()
      const result = await ctx.orchestrator.recordWorkerResult({
        projectId: PROJECT,
        taskId: ctx.taskId,
        fence: ctx.fence,
        actor: 'w1',
        outcome: 'success',
        expectedVersion: ctx.version,
        evidence,
      })
      expect(result.ok && result.value.verified).toBe(false)
    }
  })

  it('rejects a stale fence before mutating anything', async () => {
    const ctx = await started()
    const result = await ctx.orchestrator.recordWorkerResult({
      projectId: PROJECT,
      taskId: ctx.taskId,
      fence: ctx.fence - 1,
      actor: 'w1',
      outcome: 'success',
      expectedVersion: ctx.version,
      evidence: { tests: { passed: 1, failed: 0 } },
    })
    expect(result.ok === false && result.code).toBe('stale_fence')
    expect(ctx.ledger.tasks.get(ctx.taskId)?.status).toBe('leased')
    expect(ctx.worktrees.releases).toEqual([])
  })

  it('rejects a result from a worker that does not hold the lease', async () => {
    const ctx = await started()
    const result = await ctx.orchestrator.recordWorkerResult({
      projectId: PROJECT,
      taskId: ctx.taskId,
      fence: ctx.fence,
      actor: 'w2',
      outcome: 'success',
      expectedVersion: ctx.version,
    })
    expect(result.ok === false && result.code).toBe('lease_denied')
  })

  it('records a failure and marks the plan item failed', async () => {
    const ctx = await started()
    const result = await ctx.orchestrator.recordWorkerResult({
      projectId: PROJECT,
      taskId: ctx.taskId,
      fence: ctx.fence,
      actor: 'w1',
      outcome: 'failure',
      reason: 'tests still red',
      expectedVersion: ctx.version,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.task.status).toBe('failed')
    expect(result.value.item.status).toBe('failed')
    expect(result.value.verified).toBe(false)
  })
})
