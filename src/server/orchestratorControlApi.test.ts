import { describe, expect, it } from 'vitest'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { Plan, PlanStore } from './orchestrator/plan'
import {
  type ControlLedger,
  type OrchestratorControlDeps,
  orchestratorAssignRoute,
  orchestratorBootstrapRoute,
  parseAssignBody,
  parseBootstrapBody,
} from './orchestratorControlApi'

const ABS = '/srv/repo'

/** Every path is a git worktree root unless the test says otherwise. */
const anyRoot = () => true
const body = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  name: 'Project',
  path: ABS,
  items: [{ title: 'do it', scope: ['src'] }],
  ...overrides,
})

describe('bootstrap payload validation', () => {
  it('accepts a minimal body and defaults the branch base away', () => {
    const parsed = parseBootstrapBody(body(), anyRoot)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.projectId).toBe('p1')
      expect(parsed.value.branchBase).toBeUndefined()
      expect(parsed.value.items[0]).toEqual({ title: 'do it', scope: ['src'] })
    }
  })

  it('rejects non-objects, unsafe ids, control characters and oversize names', () => {
    for (const value of [null, [], 'x', 42]) {
      expect(parseBootstrapBody(value, anyRoot).ok).toBe(false)
    }
    const bad = [
      { projectId: 'has space' },
      { projectId: ':colon' },
      { projectId: 'x'.repeat(201) },
      { name: '' },
      { name: 'x'.repeat(201) },
      { name: 'line\nbreak' },
    ]
    for (const patch of bad) expect(parseBootstrapBody(body(patch), anyRoot).ok).toBe(false)
  })

  it('requires an absolute path that is an existing git worktree root', () => {
    for (const patch of [{ path: 'relative/dir' }, { path: '' }, { path: `${ABS} ` }]) {
      const parsed = parseBootstrapBody(body(patch), anyRoot)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result.body).toEqual({ error: 'invalid_path' })
    }
    // A real directory without `.git`, or no directory at all, is refused the same way.
    const notGit = parseBootstrapBody(body(), () => false)
    expect(notGit.ok).toBe(false)
    if (!notGit.ok) expect(notGit.result.body).toEqual({ error: 'invalid_path' })
  })

  it('bounds items and their scope, reusing plan normalization', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ items: [] }, 'invalid_items'],
      [{ items: [{ title: 'x' }].concat(Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` }))) }, 'invalid_items'],
      [{ items: [{ title: '' }] }, 'invalid_item_title'],
      // Scope is mandatory: no silent default.
      [{ items: [{ title: 'x' }] }, 'invalid_scope'],
      [{ items: [{ title: 'x', scope: [] }] }, 'invalid_scope'],
      [{ items: [{ title: 'x', scope: ['/abs'] }] }, 'invalid_scope'],
      [{ items: [{ title: 'x', scope: ['a/../b'] }] }, 'invalid_scope'],
      [{ items: [{ title: 'x', scope: Array.from({ length: 21 }, (_, i) => `f${i}`) }] }, 'invalid_scope'],
    ]
    for (const [patch, error] of cases) {
      const parsed = parseBootstrapBody(body(patch), anyRoot)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result.body).toEqual({ error })
    }
  })

  it('refuses client command fields and unsafe branch bases', () => {
    // Same reject list as assign: `repo`/`cwd`/`agent`/`agentId` are not bootstrap inputs.
    for (const field of ['cmd', 'command', 'exec', 'shell', 'repo', 'cwd', 'agent', 'agentId']) {
      expect(parseBootstrapBody(body({ [field]: 'rm -rf /' }), anyRoot).ok).toBe(false)
    }
    expect(parseBootstrapBody(body({ repo: 'https://example.test/x.git' }), anyRoot).ok).toBe(false)
    // `path` is bootstrap's own field and stays accepted.
    expect(parseBootstrapBody(body(), anyRoot).ok).toBe(true)
    for (const branchBase of ['-bad', 'a..b', 'has space']) {
      expect(parseBootstrapBody(body({ branchBase }), anyRoot).ok).toBe(false)
    }
    expect(parseBootstrapBody(body({ branchBase: 'main' }), anyRoot).ok).toBe(true)
  })
})

describe('assign payload validation', () => {
  it('defaults the assignee to the deterministic worker id', () => {
    const parsed = parseAssignBody({ projectId: 'p1', itemId: 'i1', expectedVersion: 1 })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.assignee).toBe('worker:p1')
  })

  it('accepts colon-bearing agent ids and rejects path-like ones', () => {
    for (const assignee of ['worker:p1', 'orch:p1', 'worker:ghost']) {
      const parsed = parseAssignBody({ projectId: 'p1', itemId: 'i1', expectedVersion: 1, assignee })
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value.assignee).toBe(assignee)
    }
    for (const assignee of ['a/b', 'a\\b', 'has space', '', ':leading']) {
      const parsed = parseAssignBody({ projectId: 'p1', itemId: 'i1', expectedVersion: 1, assignee })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result.body).toEqual({ error: 'invalid_assignee' })
    }
  })

  it('rejects path/cmd/agent fields and non-positive versions', () => {
    for (const field of ['cmd', 'path', 'repo', 'cwd', 'agent', 'agentId']) {
      const parsed = parseAssignBody({ projectId: 'p1', itemId: 'i1', expectedVersion: 1, [field]: 'x' })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.result.body).toEqual({ error: 'client_controlled_field' })
    }
    for (const expectedVersion of [0, -1, 1.5, '1']) {
      expect(parseAssignBody({ projectId: 'p1', itemId: 'i1', expectedVersion }).ok).toBe(false)
    }
  })
})

describe('control route gating', () => {
  const ledger = {} as LedgerRuntime
  const off: OrchestratorControlDeps = { ledger, enabled: false }
  const noLedger: OrchestratorControlDeps = { ledger: null, enabled: true }

  it('answers 503 orchestrator_off before reading the body', async () => {
    const bootstrap = await orchestratorBootstrapRoute(null, off)
    expect(bootstrap).toEqual({ status: 503, body: { error: 'orchestrator_off' } })
    const assign = await orchestratorAssignRoute(null, off)
    expect(assign).toEqual({ status: 503, body: { error: 'orchestrator_off' } })
  })

  it('answers 503 ledger_off without a ledger', async () => {
    expect(await orchestratorBootstrapRoute(null, noLedger)).toEqual({
      status: 503,
      body: { error: 'ledger_off' },
    })
  })
})

function pendingPlan(): Plan {
  return {
    id: 'pl1',
    projectId: 'p1',
    version: 1,
    status: 'active',
    items: [
      {
        id: 'i1',
        planId: 'pl1',
        seq: 0,
        taskId: null,
        title: 'do it',
        scope: ['src'],
        status: 'pending',
        assignee: null,
        assignedAt: null,
        updatedAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
}

function fakePlan(plan: Plan | null = pendingPlan()): Pick<PlanStore, 'get' | 'create' | 'assign'> {
  return {
    get: () => plan,
    create: () => {
      throw new Error('unused')
    },
    assign: (input) => {
      if (plan === null) throw new Error('no plan')
      plan = {
        ...plan,
        version: plan.version + 1,
        items: plan.items.map((item) =>
          item.id === input.itemId
            ? { ...item, status: 'assigned', taskId: input.taskId, assignee: input.assignee }
            : item
        ),
      }
      return plan
    },
  }
}

const unused = () => {
  throw new Error('unused')
}

function fakePort(agent: { id: string; projectId: string; role: string; depth: number; state: string } | null): ControlLedger {
  return {
    project: { getProject: () => null, createProject: unused },
    agent: { getAgent: () => agent, createAgent: unused },
    task: {
      createTask: (input: { projectId: string; agentId?: string }) => ({
        id: 't1',
        projectId: input.projectId,
        agentId: input.agentId ?? null,
        status: 'pending',
        fence: 0,
        leaseOwner: null,
        leaseExpires: null,
        attempt: 0,
        maxAttempts: 3,
        evidence: null,
      }),
      getTask: () => null,
      leaseTask: () => null,
      claimDone: unused,
      verifyTask: unused,
      failTask: unused,
    },
    event: { appendEvent: () => null },
  } as unknown as ControlLedger
}

const worker = { id: 'worker:p1', projectId: 'p1', role: 'worker', depth: 2, state: 'idle' }

function deps(overrides: Partial<OrchestratorControlDeps> = {}): OrchestratorControlDeps {
  return {
    ledger: {} as LedgerRuntime,
    enabled: true,
    ledgerPort: fakePort(worker),
    plan: fakePlan(),
    ...overrides,
  }
}

describe('assign routing', () => {
  it('returns taskId + planVersion for a pending item', async () => {
    const result = await orchestratorAssignRoute(
      { projectId: 'p1', itemId: 'i1', expectedVersion: 1 },
      deps()
    )
    expect(result).toEqual({ status: 200, body: { ok: true, taskId: 't1', planVersion: 2 } })
  })

  it('maps a missing plan to 409 and never touches the ledger', async () => {
    const result = await orchestratorAssignRoute(
      { projectId: 'p1', itemId: 'i1', expectedVersion: 1 },
      deps({ plan: fakePlan(null) })
    )
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'plan_missing' })
  })

  it('accepts an explicit worker id and types the wrong-role/ghost rejections', async () => {
    const explicit = await orchestratorAssignRoute(
      { projectId: 'p1', itemId: 'i1', expectedVersion: 1, assignee: 'worker:p1' },
      deps()
    )
    expect(explicit.status).toBe(200)

    const orchestrator = await orchestratorAssignRoute(
      { projectId: 'p1', itemId: 'i1', expectedVersion: 1, assignee: 'orch:p1' },
      deps({ ledgerPort: fakePort({ ...worker, role: 'orchestrator', depth: 1 }) })
    )
    expect(orchestrator.status).toBe(400)
    expect(orchestrator.body).toMatchObject({ ok: false, error: 'wrong_role' })

    const ghost = await orchestratorAssignRoute(
      { projectId: 'p1', itemId: 'i1', expectedVersion: 1, assignee: 'worker:ghost' },
      deps({ ledgerPort: fakePort(null) })
    )
    expect(ghost.status).toBe(400)
    expect(ghost.body).toMatchObject({ ok: false, error: 'agent_not_found' })
  })
})
