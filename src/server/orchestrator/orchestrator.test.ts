import { describe, expect, it } from 'vitest'
import { PROJECT, item, orchAgent, planOf, setup, worker } from './orchestrator.fake.testutil'

describe('canSpawn', () => {
  it('allows central -> orchestrator and orchestrator -> worker', () => {
    const { orchestrator } = setup(planOf([item()]))
    expect(orchestrator.canSpawn({ role: 'central', depth: 0 })).toEqual({
      ok: true,
      value: { role: 'orchestrator', depth: 1 },
    })
    expect(orchestrator.canSpawn({ role: 'orchestrator', depth: 1 })).toEqual({
      ok: true,
      value: { role: 'worker', depth: 2 },
    })
  })

  it('denies worker spawn and never grants depth 3', () => {
    const { orchestrator } = setup(planOf([item()]))
    const workerDeny = orchestrator.canSpawn({ role: 'worker', depth: 2 })
    expect(workerDeny.ok === false && workerDeny.code).toBe('wrong_role')
    // Depth 3 cannot even exist: the role/depth table rejects it before spawn math.
    const deep = orchestrator.canSpawn({ role: 'central', depth: 3 })
    expect(deep.ok).toBe(false)
    expect(orchestrator.canSpawn({ role: 'lead', depth: 0 }).ok).toBe(false)
  })
})

describe('assignTask', () => {
  it('creates a task and links it to a pending plan item', () => {
    const { orchestrator, ledger } = setup(planOf([item()]))
    const result = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i1',
      assignee: 'w1',
      expectedVersion: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.task.id).toBe('t1')
    expect(result.value.task.status).toBe('pending')
    expect(result.value.item.status).toBe('assigned')
    expect(result.value.item.taskId).toBe('t1')
    expect(result.value.plan.version).toBe(2)
    expect(ledger.events.map((event) => event.kind)).toEqual(['orchestrator.task_assigned'])
  })

  it('rejects a stale plan version without assigning twice', () => {
    const { orchestrator, ledger } = setup(planOf([item()]))
    const first = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i1',
      assignee: 'w1',
      expectedVersion: 1,
    })
    expect(first.ok).toBe(true)
    const stale = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i1',
      assignee: 'w1',
      expectedVersion: 1,
    })
    expect(stale.ok === false && stale.code).toBe('plan_stale')
    expect(ledger.created).toBe(1)
  })

  it('denies non-worker and unknown agents', () => {
    const { orchestrator } = setup(planOf([item()]), [worker(), orchAgent])
    const role = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i1',
      assignee: 'o1',
      expectedVersion: 1,
    })
    expect(role.ok === false && role.code).toBe('wrong_role')

    const foreign = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i1',
      assignee: 'ghost',
      expectedVersion: 1,
    })
    expect(foreign.ok === false && foreign.code).toBe('agent_not_found')
  })

  it('denies a worker that belongs to another project', () => {
    const { orchestrator, ledger } = setup(planOf([item()]), [worker('w9', { projectId: 'p2' })])
    const result = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'i1',
      assignee: 'w9',
      expectedVersion: 1,
    })
    expect(result.ok === false && result.code).toBe('project_mismatch')
    expect(ledger.created).toBe(0)
  })

  it('denies a missing plan or item', () => {
    const { orchestrator } = setup(planOf([item()]))
    expect(
      orchestrator.assignTask({ projectId: 'p9', itemId: 'i1', assignee: 'w1', expectedVersion: 1 }).ok
    ).toBe(false)
    const missing = orchestrator.assignTask({
      projectId: PROJECT,
      itemId: 'nope',
      assignee: 'w1',
      expectedVersion: 1,
    })
    expect(missing.ok === false && missing.code).toBe('item_not_found')
  })
})
