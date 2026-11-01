import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { PlanStore } from './orchestrator/plan'
import type { PlanItem, PlanStatus } from './orchestrator/planModel'
import type { WorktreeService } from './orchestrator/worktree'
import type { WorkerRunInput, WorkerRunOutcome } from './orchestrator/workerRuntime'
import {
  type OrchestratorRunDeps,
  type RuntimeCompose,
  orchestratorRunRoute,
  parseRunBody,
} from './orchestratorRunApi'

const REPO = '/srv/repos/project-one'

// Routes now mkdir `<data>/worktrees`, so tests get throwaway data dirs instead of /tmp litter.
const tempDirs: string[] = []
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'webterm-data-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The fake row answers both the repo query and the pause query, like a real project row would.
function runtime(projectPath: string | null = REPO, status = 'active'): LedgerRuntime {
  const db = {
    query: () => ({
      get: () => (projectPath === null ? null : { path: projectPath, status }),
    }),
  }
  return { db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime
}

function item(patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'i1',
    planId: 'pl1',
    seq: 0,
    taskId: 't1',
    title: 'build API',
    scope: ['src/server'],
    status: 'assigned',
    assignee: 'ag1',
    assignedAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function planStore(entry: PlanItem | null, status: PlanStatus = 'active'): Pick<PlanStore, 'get'> {
  return {
    get: () =>
      entry === null
        ? null
        : {
            id: 'pl1',
            projectId: 'p1',
            version: 1,
            status,
            items: [entry],
            createdAt: 1,
            updatedAt: 1,
          },
  }
}

function outcome(patch: Partial<WorkerRunOutcome> = {}): WorkerRunOutcome {
  return { ok: true, task: null, plan: null, nodeId: 'w-t1-1', output: 'done', ...patch }
}

interface Captured {
  input?: WorkerRunInput
  compose?: RuntimeCompose
  calls: number
}

function deps(
  run: (input: WorkerRunInput) => Promise<WorkerRunOutcome>,
  overrides: Partial<OrchestratorRunDeps> = {}
): { deps: OrchestratorRunDeps; captured: Captured } {
  const captured: Captured = { calls: 0 }
  const dataDir = tempDataDir()
  return {
    captured,
    deps: {
      ledger: runtime(),
      enabled: true,
      planStore: planStore(item()),
      dataDir: () => dataDir,
      settings: () => ({ agentLaunchCommands: {} }),
      createRuntime: (compose) => {
        captured.compose = compose
        return {
          runTask: (input) => {
            captured.calls += 1
            captured.input = input
            return run(input)
          },
        }
      },
      ...overrides,
    },
  }
}

const valid = { projectId: 'p1', itemId: 'i1', expectedVersion: 1 }

describe('orchestrator run validation', () => {
  it('rejects a client-supplied repo or command: those are server-resolved', () => {
    for (const field of ['repo', 'cmd', 'path', 'agent', 'exec'] as const) {
      const parsed = parseRunBody({ ...valid, [field]: '/tmp/evil' })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.result.status).toBe(400)
        expect(parsed.result.body).toMatchObject({ error: 'client_controlled_field' })
      }
    }
  })

  it('bounds ids, prompt, version and baseRef', () => {
    expect(parseRunBody(null).ok).toBe(false)
    expect(parseRunBody({ ...valid, projectId: '  ' }).ok).toBe(false)
    expect(parseRunBody({ ...valid, itemId: 'x'.repeat(201) }).ok).toBe(false)
    expect(parseRunBody({ ...valid, expectedVersion: -1 }).ok).toBe(false)
    expect(parseRunBody({ ...valid, expectedVersion: 1.5 }).ok).toBe(false)
    expect(parseRunBody({ ...valid, prompt: 'x'.repeat(2001) }).ok).toBe(false)
    expect(parseRunBody({ ...valid, baseRef: '-bad' }).ok).toBe(false)
    expect(parseRunBody({ ...valid, timeoutMs: 'soon' }).ok).toBe(false)
  })

  it('clamps timeoutMs to 5s..15min', () => {
    const low = parseRunBody({ ...valid, timeoutMs: 1 })
    const high = parseRunBody({ ...valid, timeoutMs: 60 * 60_000 })
    expect(low.ok && low.value.timeoutMs).toBe(5_000)
    expect(high.ok && high.value.timeoutMs).toBe(900_000)
  })
})

describe('orchestrator run route', () => {
  it('answers 503 when the flag or ledger is off', async () => {
    const flagOff = await orchestratorRunRoute(valid, { ledger: runtime(), enabled: false })
    expect(flagOff).toEqual({ status: 503, body: { error: 'orchestrator_off' } })
    const ledgerOff = await orchestratorRunRoute(valid, { ledger: null, enabled: true })
    expect(ledgerOff).toEqual({ status: 503, body: { error: 'ledger_off' } })
  })

  it('refuses to run without an assigned plan item and never builds a runtime', async () => {
    const pending = deps(async () => outcome(), { planStore: planStore(item({ status: 'pending', taskId: null, assignee: null })) })
    const result = await orchestratorRunRoute(valid, pending.deps)
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'not_assigned' })
    expect(pending.captured.calls).toBe(0)

    const noPlan = deps(async () => outcome(), { planStore: planStore(null) })
    expect((await orchestratorRunRoute(valid, noPlan.deps)).status).toBe(409)
  })

  it('uses the ledger project path as repo and the settings launcher as cmd', async () => {
    const run = deps(async () => outcome(), {
      settings: () => ({ agentLaunchCommands: { claude: 'claude-work' } }),
    })
    const result = await orchestratorRunRoute(
      { ...valid, prompt: 'focus on tests', baseRef: 'main' },
      run.deps
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(run.captured.compose?.repo).toBe(REPO)
    expect(run.captured.compose?.cmd).toBe('claude-work')
    expect(run.captured.input).toMatchObject({
      projectId: 'p1',
      itemId: 'i1',
      expectedVersion: 1,
      repo: REPO,
      prompt: 'focus on tests',
      baseRef: 'main',
    })
  })

  it('maps a worker denial to 409 and an unexpected throw to 500', async () => {
    const denied = deps(async () =>
      outcome({ ok: false, error: { code: 'cap_denied', message: 'caps blocked worker start' } })
    )
    const result = await orchestratorRunRoute(valid, denied.deps)
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'cap_denied' } })

    const broken = deps(async () => {
      throw new Error(`secret path ${REPO}`)
    })
    const failed = await orchestratorRunRoute(valid, broken.deps)
    expect(failed.status).toBe(500)
    expect(JSON.stringify(failed.body)).not.toContain(REPO)
  })

  it('answers 409 project_paused for a paused project and touches nothing', async () => {
    const dataDir = tempDataDir()
    const run = deps(async () => outcome(), {
      ledger: runtime(REPO, 'paused'),
      dataDir: () => dataDir,
    })
    const result = await orchestratorRunRoute(valid, run.deps)
    expect(result).toEqual({
      status: 409,
      body: { error: 'project_paused', message: 'project p1 is paused; resume it before running' },
    })
    expect(run.captured.calls).toBe(0)
    expect(run.captured.compose).toBeUndefined()
    // No worktree root is created before the gate, so a paused project leaves no trace.
    expect(existsSync(join(dataDir, 'worktrees'))).toBe(false)
  })

  it('still runs an active project unchanged', async () => {
    const run = deps(async () => outcome(), { ledger: runtime(REPO, 'active') })
    const result = await orchestratorRunRoute(valid, run.deps)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(run.captured.calls).toBe(1)
  })

  it.each(['completed', 'abandoned'] as const)(
    'answers 409 plan_closed for a %s plan and touches nothing',
    async (status) => {
      const dataDir = tempDataDir()
      const run = deps(async () => outcome(), {
        planStore: planStore(item(), status),
        dataDir: () => dataDir,
      })
      const result = await orchestratorRunRoute(valid, run.deps)
      expect(result).toEqual({
        status: 409,
        body: { error: 'plan_closed', message: `plan pl1 is ${status}; no new runs` },
      })
      expect(run.captured.calls).toBe(0)
      expect(run.captured.compose).toBeUndefined()
      expect(existsSync(join(dataDir, 'worktrees'))).toBe(false)
    }
  )

  it.each(['draft', 'active'] as const)('still runs a %s plan', async (status) => {
    const run = deps(async () => outcome(), { planStore: planStore(item(), status) })
    const result = await orchestratorRunRoute(valid, run.deps)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(run.captured.calls).toBe(1)
  })

  it('treats a project without a repo path as not runnable', async () => {
    const run = deps(async () => outcome(), { ledger: runtime(null) })
    const result = await orchestratorRunRoute(valid, run.deps)
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'not_assigned' })
  })

  it('passes an injected worktree service through instead of creating one', async () => {
    const worktrees = {
      allocate: async () => {
        throw new Error('unused')
      },
      release: async () => {
        throw new Error('unused')
      },
      get: () => undefined,
      list: () => [],
    } as WorktreeService
    const run = deps(async () => outcome(), { worktrees })
    await orchestratorRunRoute(valid, run.deps)
    expect(run.captured.compose?.worktrees).toBe(worktrees)
  })

  it('creates the missing <data>/worktrees root before building the service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webterm-root-'))
    try {
      const run = deps(async () => outcome(), { dataDir: () => dir })
      const result = await orchestratorRunRoute(valid, run.deps)
      expect(result.status).toBe(200)
      const root = join(dir, 'worktrees')
      expect(run.captured.compose?.root).toBe(root)
      expect(statSync(root).isDirectory()).toBe(true)
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(run.captured.calls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers a sanitized 500 without spawning when the root cannot be created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webterm-root-'))
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x')
    try {
      const run = deps(async () => outcome(), { dataDir: () => blocker })
      const result = await orchestratorRunRoute(valid, run.deps)
      expect(result.status).toBe(500)
      expect(result.body).toMatchObject({
        ok: false,
        error: { code: 'worktree_root_failed' },
      })
      expect(JSON.stringify(result.body)).not.toContain(dir)
      expect(run.captured.calls).toBe(0)
      expect(run.captured.compose).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
