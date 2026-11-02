// Fake bersama untuk test orkestrator. Bukan file test (`*.testutil.ts`), jadi tidak
// dijalankan runner mana pun; vitest meng-import-nya dari test di sebelahnya.
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { DEFAULT_CAPS } from './caps'
import { PlanError, StalePlanVersionError, type Plan, type PlanItem, type PlanStore } from './plan'
import type { OrchestratorAgent, OrchestratorLedger, OrchestratorTask } from './orchestratorModel'
import { WorktreeError, type WorktreeAllocation, type WorktreeService } from './worktree'

export const PROJECT = 'p1'
export const REPO = '/tmp/repo'

export function item(patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'i1',
    planId: 'pl1',
    seq: 0,
    taskId: null,
    title: 'build API',
    scope: ['src/api.ts'],
    status: 'pending',
    assignee: null,
    assignedAt: null,
    updatedAt: 1000,
    ...patch,
  }
}

export function planOf(items: PlanItem[]): Plan {
  return {
    id: 'pl1',
    projectId: PROJECT,
    version: 1,
    status: 'active',
    items,
    createdAt: 1000,
    updatedAt: 1000,
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** In-memory PlanStore honouring the version + participant rules the orchestrator relies on. */
function fakePlanStore(initial: Plan): PlanStore {
  const state = { plan: clone(initial) }
  const bump = () => {
    state.plan.version += 1
    state.plan.updatedAt = 1000
  }
  const version = (expected: number) => {
    if (state.plan.version !== expected) {
      throw new StalePlanVersionError(state.plan.projectId, expected, state.plan.version)
    }
  }
  const find = (id: string, expected: number): PlanItem => {
    version(expected)
    const found = state.plan.items.find((candidate) => candidate.id === id)
    if (!found) throw new PlanError('item_not_found', `no item ${id}`)
    return found
  }
  return {
    get: () => clone(state.plan),
    create: () => {
      throw new Error('fake create unused')
    },
    replace: () => {
      throw new Error('fake replace unused')
    },
    assign(input) {
      const target = find(input.itemId, input.expectedVersion)
      if (target.status !== 'pending' || target.taskId !== null) {
        throw new PlanError('task_already_assigned', `item ${target.id} already assigned`)
      }
      target.status = 'assigned'
      target.taskId = input.taskId
      target.assignee = input.assignee
      target.assignedAt = 1000
      bump()
      return clone(state.plan)
    },
    updateItem(input) {
      const target = find(input.itemId, input.expectedVersion)
      if (target.assignee !== input.actor) {
        throw new PlanError('not_participant', `caller ${input.actor} is not ${target.assignee}`)
      }
      target.status = input.status
      target.updatedAt = 1000
      bump()
      return clone(state.plan)
    },
  }
}

export interface FakeLedger extends OrchestratorLedger {
  tasks: Map<string, OrchestratorTask>
  agents: Map<string, OrchestratorAgent>
  events: { kind: string }[]
  leaseFails: boolean
  created: number
}

function fakeLedger(agents: OrchestratorAgent[], withTx = true): FakeLedger {
  const tasks = new Map<string, OrchestratorTask>()
  let seq = 0
  const requireTask = (id: string): OrchestratorTask => {
    const task = tasks.get(id)
    if (!task) throw new Error(`fake ledger: no task ${id}`)
    return task
  }
  /** Snapshot/restore minimal untuk meniru ROLLBACK saat fn melempar. */
  const runInTx = <T>(fn: () => T): T => {
    const taskSnapshot = new Map([...tasks].map(([id, task]) => [id, clone(task)]))
    const eventCount = ledger.events.length
    try {
      return fn()
    } catch (err) {
      tasks.clear()
      for (const [id, task] of taskSnapshot) tasks.set(id, task)
      ledger.events.splice(eventCount)
      throw err
    }
  }
  const ledger: FakeLedger = {
    tasks,
    agents: new Map(agents.map((agent) => [agent.id, agent])),
    events: [],
    leaseFails: false,
    created: 0,
    ...(withTx ? { tx: runInTx } : {}),
    agent: { getAgent: (id) => ledger.agents.get(id) ?? null },
    task: {
      createTask(input) {
        seq += 1
        ledger.created += 1
        const task: OrchestratorTask = {
          id: `t${seq}`,
          projectId: input.projectId,
          agentId: input.agentId ?? null,
          status: 'pending',
          fence: 0,
          leaseOwner: null,
          leaseExpires: null,
          attempt: 0,
          maxAttempts: input.maxAttempts ?? 3,
          evidence: null,
        }
        tasks.set(task.id, task)
        return task
      },
      getTask: (id) => tasks.get(id) ?? null,
      leaseTask(id, input) {
        if (ledger.leaseFails) return null
        const task = requireTask(id)
        task.status = 'leased'
        task.fence += 1
        task.attempt += 1
        task.leaseOwner = input.owner
        task.leaseExpires = 1000 + input.ttlMs
        return clone(task)
      },
      claimDone(id, fence, evidence) {
        const task = requireTask(id)
        if (task.fence !== fence) throw new Error('fake: stale fence')
        task.status = 'claimed_done'
        task.evidence = evidence
        return clone(task)
      },
      verifyTask(id, fence) {
        const task = requireTask(id)
        if (task.fence !== fence) throw new Error('fake: stale fence')
        task.status = 'verified'
        return clone(task)
      },
      failTask(id, fence, reason) {
        const task = requireTask(id)
        if (task.fence !== fence) throw new Error('fake: stale fence')
        task.status = 'failed'
        task.evidence = { reason }
        return clone(task)
      },
    },
    event: { appendEvent: (event) => ledger.events.push({ kind: event.kind }) },
  }
  return ledger
}

export interface FakeWorktrees extends WorktreeService {
  allocations: WorktreeAllocation[]
  releases: string[]
  failAllocate: boolean
}

function fakeWorktrees(): FakeWorktrees {
  const allocations: WorktreeAllocation[] = []
  const fake: FakeWorktrees = {
    allocations,
    releases: [],
    failAllocate: false,
    async allocate(input) {
      if (fake.failAllocate) throw new WorktreeError('git_failed', 'git refused')
      const allocation: WorktreeAllocation = {
        taskId: input.taskId,
        branch: input.branch,
        path: `/tmp/wt/${input.taskId}`,
        repo: input.repo,
        owner: input.owner,
        createdAt: 1000,
      }
      allocations.push(allocation)
      return allocation
    },
    async release(input) {
      fake.releases.push(input.taskId)
      const index = allocations.findIndex((a) => a.taskId === input.taskId)
      if (index < 0) throw new WorktreeError('not_found', 'no allocation')
      return allocations.splice(index, 1)[0] as WorktreeAllocation
    },
    get: (taskId) => allocations.find((a) => a.taskId === taskId),
    list: () => [...allocations],
  }
  return fake
}

export function worker(id = 'w1', patch: Partial<OrchestratorAgent> = {}): OrchestratorAgent {
  return { id, projectId: PROJECT, role: 'worker', depth: 2, state: 'idle', ...patch }
}

export const orchAgent: OrchestratorAgent = {
  id: 'o1',
  projectId: PROJECT,
  role: 'orchestrator',
  depth: 1,
  state: 'idle',
}

export interface Fixture {
  orchestrator: Orchestrator
  ledger: FakeLedger
  worktrees: FakeWorktrees
}

export function setup(initial: Plan, agents: OrchestratorAgent[] = [worker()]): Fixture {
  return setupWith(initial, agents, {})
}

export interface SetupOptions {
  /** Default true: fake ledger menyediakan `tx` dengan rollback snapshot. */
  tx?: boolean
}

export function setupWith(
  initial: Plan,
  agents: OrchestratorAgent[] = [worker()],
  options: SetupOptions = {}
): Fixture {
  const ledger = fakeLedger(agents, options.tx ?? true)
  const worktrees = fakeWorktrees()
  const orchestrator = createOrchestrator({
    ledger,
    plan: fakePlanStore(initial),
    worktrees,
    caps: DEFAULT_CAPS,
    branchPrefix: 'agent',
  })
  return { orchestrator, ledger, worktrees }
}
