import { describe, expect, it } from 'vitest'
import { createFakeWorkers } from './fakeWorkerAdapter'

describe('createFakeWorkers', () => {
  it('success: server-verified evidence ends verified and releases the worktree', async () => {
    const workers = createFakeWorkers()
    const run = await workers.run('success')
    expect(run).toMatchObject({ verified: true, taskStatus: 'verified', itemStatus: 'done' })
    expect(workers.fixture.worktrees.allocations).toHaveLength(0)
    expect(workers.fixture.worktrees.releases).toEqual([run.taskId])
  })

  it('failure: reported failure fails the task and never verifies', async () => {
    const run = await createFakeWorkers().run('failure')
    expect(run.verified).toBe(false)
    expect(run.taskStatus).toBe('failed')
  })

  it('hang: the worker never reports, so the lease and worktree stay held', async () => {
    const workers = createFakeWorkers()
    const run = await workers.run('hang')
    expect(run).toMatchObject({ verified: false, taskStatus: 'leased', itemStatus: 'running' })
    expect(workers.fixture.worktrees.allocations).toHaveLength(1)
  })

  it('forged: a success claim without the server marker is not verified', async () => {
    const run = await createFakeWorkers().run('forged')
    expect(run.verified).toBe(false)
    expect(run.taskStatus).not.toBe('verified')
  })

  it('drives items in order and fails loudly once none are left', async () => {
    const workers = createFakeWorkers(2)
    expect((await workers.run('success')).itemId).toBe('i1')
    expect((await workers.run('success')).itemId).toBe('i2')
    await expect(workers.run('success')).rejects.toThrow('no pending item left')
  })
})
