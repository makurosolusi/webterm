import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Approval } from '../../../ledger/ledgerApproval'
import { approvalDigest } from '../../../ledger/ledgerApproval'
import type { LedgerRuntime } from '../../../ledger/ledgerRuntime'
import type { PlanItem } from '../../../orchestrator/planModel'
import type { WorkerRunInput, WorkerRunOutcome } from '../../../orchestrator/workerRuntime'
import type { OrchestratorRunDeps } from '../../../orchestratorRunProduction'
import { openFixture, seedPortfolio, type Fixture } from '../../centralTestFixture.testutil'
import { ALLOW_ALL_GUARD, execTool } from '../toolExec'
import { createRegistry } from '../toolRegistry'
import type { ControlGuard, Tier, ToolCtx } from '../toolTypes'
import type { AssignmentView } from '../../../../shared/centralWork'
import { finishTask } from '../../work/workLifecycle'
import { createWorkStore } from '../../work/workStore'
import { createWorkSupervisor } from '../../work/workSupervisor'
import { createTaskRunDef, runGateFlags } from './task.run.def'

const FIVE_MINUTES_MS = 5 * 60_000

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const item: PlanItem = { id: 'i1', planId: 'pl1', seq: 0, taskId: 't1', title: 'build', scope: ['src'], status: 'assigned', assignee: 'ag1', assignedAt: 1, updatedAt: 1 }
const plan = (version: number) => ({ get: () => ({ id: 'pl1', projectId: 'p1', version, status: 'active' as const, items: [item], createdAt: 1, updatedAt: 1 }) })
const outcome = (patch: Partial<WorkerRunOutcome> = {}): WorkerRunOutcome => ({ ok: true, task: null, plan: null, nodeId: 'w-t1-1', output: '', ...patch })

interface Setup { f: Fixture; ctx: ToolCtx; runs: WorkerRunInput[]; consumed: string[] }

function setup(opts: { env?: Record<string, string>; maxTier?: Tier; guard?: ControlGuard; version?: number; approval?: Approval | null; run?: () => WorkerRunOutcome } = {}): Setup {
  const f = openFixture()
  seedPortfolio(f.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'webterm-taskrun-'))
  dirs.push(dataDir)
  const runs: WorkerRunInput[] = []
  const consumed: string[] = []
  const deps: OrchestratorRunDeps = {
    ledger: { db: f.db, mode: 'on', path: ':memory:', ledger: {} } as unknown as LedgerRuntime,
    enabled: true,
    requireApproval: opts.env?.WEBTERM_RUN_REQUIRE_APPROVAL === 'on',
    planStore: plan(opts.version ?? 1),
    dataDir: () => dataDir,
    settings: () => ({}), claudeOnPath: () => true,
    approval: {
      getApproval: () => opts.approval ?? null,
      consumeApproval: (id) => {
        consumed.push(id)
        return true
      },
    },
    createRuntime: () => ({ runTask: async (input) => (runs.push(input), (opts.run ?? outcome)()) }),
  }
  const registry = createRegistry()
  registry.register(createTaskRunDef(() => deps))
  const ctx: ToolCtx = { db: f.db, registry, guard: opts.guard ?? ALLOW_ALL_GUARD, maxTier: opts.maxTier ?? 'R2', conversationId: 'global', now: () => 1_700_000_000_000, env: { WEBTERM_ORCHESTRATOR_RUN: 'on', ...opts.env } }
  return { f, ctx, runs, consumed }
}

const args = { projectId: 'p1', itemId: 'i1', expectedVersion: 1 }
const ACTION = { action: 'worker.run', projectId: 'p1', itemId: 'i1' }
const approved = (request: unknown = ACTION): Approval => ({ id: 'ap1', projectId: 'p1', taskId: null, kind: 'worker.run', request, status: 'approved', approvedBy: 'human', expiresAt: null, createdAt: 1, updatedAt: 2 })

describe('task.run tool', () => {
  it('is R2: an R1 caller is denied before anything runs', async () => {
    const s = setup({ maxTier: 'R1' })
    expect(await execTool(s.ctx, 'task.run', args)).toMatchObject({ ok: false, code: 'tier_denied' })
    expect(s.runs).toHaveLength(0)
  })

  it('does not exist while WEBTERM_ORCHESTRATOR_RUN is off', async () => {
    const s = setup({ env: { WEBTERM_ORCHESTRATOR_RUN: 'off' } })
    expect(await execTool(s.ctx, 'task.run', args)).toMatchObject({ ok: false, code: 'flag_off' })
  })

  it('rejects model-supplied digests, extra keys and a missing expectedVersion', async () => {
    const s = setup()
    for (const bad of [{ ...args, approvalDigest: 'a'.repeat(64) }, { ...args, cmd: 'rm' }, { projectId: 'p1', itemId: 'i1' }, { ...args, expectedVersion: 0 }]) {
      expect((await execTool(s.ctx, 'task.run', bad)).ok).toBe(false)
    }
    expect(s.runs).toHaveLength(0)
  })

  it('runs the item and reports task/plan/node when no approval is required', async () => {
    const s = setup({ run: () => outcome({ task: { id: 't1' } as never, plan: { version: 2 } as never }) })
    const result = await execTool(s.ctx, 'task.run', args)
    expect(result).toMatchObject({ ok: true, tool: 'task.run', data: { taskId: 't1', planVersion: 2, nodeId: 'w-t1-1' } })
    expect(s.runs).toHaveLength(1)
    expect(s.runs[0]).toMatchObject({ projectId: 'p1', itemId: 'i1', expectedVersion: 1 })
  })

  it('refuses without approval when RUN_REQUIRE_APPROVAL is on, and spawns nothing', async () => {
    const s = setup({ env: { WEBTERM_RUN_REQUIRE_APPROVAL: 'on' } })
    expect(await execTool(s.ctx, 'task.run', args)).toMatchObject({ ok: false, code: 'approval_required' })
    expect(s.runs).toHaveLength(0)
    expect(s.consumed).toHaveLength(0)
  })

  it('gerbang default sama dengan API: env kosong + RUN on => requireApproval true, off eksplisit => false', () => {
    const on = { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on' }
    expect(runGateFlags(on)).toEqual({ enabled: true, requireApproval: true })
    expect(runGateFlags({ ...on, WEBTERM_RUN_REQUIRE_APPROVAL: 'off' })).toEqual({ enabled: true, requireApproval: false })
    expect(runGateFlags({ WEBTERM_ORCHESTRATOR_RUN: 'on' }).enabled).toBe(false) // workers implies central
    expect(runGateFlags(on, true)).toEqual({ enabled: true, requireApproval: false })
    expect(runGateFlags(on, false)).toEqual({ enabled: true, requireApproval: true })
  })

  it('consumes an approval bound to this exact item, and rejects one approved for another item', async () => {
    const good = setup({ env: { WEBTERM_RUN_REQUIRE_APPROVAL: 'on' }, approval: approved() })
    expect((await execTool(good.ctx, 'task.run', { ...args, approvalId: 'ap1' })).ok).toBe(true)
    expect(good.consumed).toEqual(['ap1'])
    expect(good.runs).toHaveLength(1)

    const other = setup({ env: { WEBTERM_RUN_REQUIRE_APPROVAL: 'on' }, approval: approved({ ...ACTION, itemId: 'i9' }) })
    expect(await execTool(other.ctx, 'task.run', { ...args, approvalId: 'ap1' })).toMatchObject({ ok: false, code: 'approval_digest_mismatch' })
    expect(other.consumed).toHaveLength(0)
    expect(other.runs).toHaveLength(0)
    expect(approvalDigest(ACTION)).not.toBe(approvalDigest({ ...ACTION, itemId: 'i9' }))
  })

  it('answers conflict when expectedVersion is stale, before any approval is spent', async () => {
    const s = setup({ env: { WEBTERM_RUN_REQUIRE_APPROVAL: 'on' }, version: 3, approval: approved() })
    expect(await execTool(s.ctx, 'task.run', { ...args, approvalId: 'ap1' })).toMatchObject({ ok: false, code: 'conflict' })
    expect(s.consumed).toHaveLength(0)
    expect(s.runs).toHaveLength(0)
  })

  it('maps a runtime plan_stale denial to conflict and surfaces worker failures by code', async () => {
    const stale = setup({ run: () => outcome({ ok: false, error: { code: 'plan_stale', message: 'plan moved' } }) })
    expect(await execTool(stale.ctx, 'task.run', args)).toMatchObject({ ok: false, code: 'conflict' })
    const failed = setup({ run: () => outcome({ ok: false, error: { code: 'verify_failed', message: 'tests red' } }) })
    expect(await execTool(failed.ctx, 'task.run', args)).toMatchObject({ ok: false, code: 'verify_failed' })
  })

  it('respects the control guard', async () => {
    const s = setup({ guard: { check: () => ({ ok: false, code: 'budget_exhausted' }) } })
    expect(await execTool(s.ctx, 'task.run', args)).toMatchObject({ ok: false, code: 'budget_exhausted' })
    expect(s.runs).toHaveLength(0)
  })
})

describe('task.run delegation', () => {
  const store = (s: Setup) => createWorkStore(s.f.db, () => 1)

  it('records the run under its plan item before it starts', async () => {
    let seen: AssignmentView | null = null
    const s = setup({ run: () => { seen = store(s).openAssignmentOfNode('run:i1'); return outcome() } })
    const res = await execTool(s.ctx, 'task.run', args)
    expect(seen).toMatchObject({ channel: 'run', instruction: 'build' })
    expect(res.data).toMatchObject({ assignmentId: expect.any(String), workTaskId: expect.any(String), nodeId: 'w-t1-1' })
  })

  const supervisorOf = (s: Setup) => createWorkSupervisor({
    store: store(s), now: s.ctx.now,
    ports: { isLive: () => true, input: () => {}, chatBusy: () => false, chatNodeGone: () => false, chatSend: async () => ({ ok: true }), agentOf: () => null },
  })
  const rulesOf = (s: Setup, taskId: string) => store(s).timeline(taskId).map((e) => e.rule)
  const idsOf = (res: { data?: unknown }) => res.data as { workTaskId: string; assignmentId: string }

  it('a successful run lands in needs_review with its outcome, and a later tick does not stall it', async () => {
    const s = setup({ run: () => outcome({ task: { id: 't1' } as never, plan: { version: 2 } as never }) })
    const { workTaskId, assignmentId } = idsOf(await execTool(s.ctx, 'task.run', args))
    expect(store(s).getTask(workTaskId)?.status).toBe('needs_review')
    expect(rulesOf(s, workTaskId)).toContain('run_finished')
    expect(store(s).getAssignment(assignmentId)).toMatchObject({ endedAt: expect.any(Number), result: { taskId: 't1', nodeId: 'w-t1-1', planVersion: 2 } })

    await supervisorOf(s).tick(s.ctx.now() + FIVE_MINUTES_MS)
    expect(store(s).getTask(workTaskId)?.status).toBe('needs_review')
    expect(rulesOf(s, workTaskId)).not.toContain('startup')
  })

  it('a run the startup rule stalled while it blocked still lands in needs_review', async () => {
    let during: string | undefined
    const s = setup({
      run: () => {
        void supervisorOf(s).tick(s.ctx.now() + FIVE_MINUTES_MS)
        during = store(s).listTasks({ projectId: 'p1' })[0]?.status
        return outcome()
      },
    })
    const { workTaskId } = idsOf(await execTool(s.ctx, 'task.run', args))
    expect(during).toBe('stalled')
    expect(store(s).getTask(workTaskId)?.status).toBe('needs_review')
  })

  it('a run that only followed up an already open assignment does not settle it', async () => {
    const s = setup()
    store(s).createTask({ id: 'w1', projectId: 'p1', title: 'build', objective: 'build', actor: { kind: 'central' } })
    const open = store(s).openAssignment({ taskId: 'w1', nodeId: 'run:i1', channel: 'run', instruction: 'build', actor: { kind: 'central' } })
    expect(idsOf(await execTool(s.ctx, 'task.run', args)).assignmentId).toBe(open.id)
    expect(store(s).getTask('w1')?.status).toBe('assigned')
    expect(store(s).getAssignment(open.id)).toMatchObject({ endedAt: null, result: null })
  })

  it('a run whose card was cancelled meanwhile leaves the card alone', async () => {
    const s = setup({
      run: () => {
        const id = store(s).listTasks({ projectId: 'p1' })[0]?.id as string
        finishTask(store(s), id, 'cancelled', { actor: { kind: 'human' }, reason: 'stop' })
        return outcome()
      },
    })
    const res = await execTool(s.ctx, 'task.run', args)
    expect(res.ok).toBe(true)
    expect(store(s).getTask(idsOf(res).workTaskId)?.status).toBe('cancelled')
    expect(rulesOf(s, idsOf(res).workTaskId)).not.toContain('run_finished')
  })

  it('a run the route refuses before starting records nothing', async () => {
    const needsApproval = setup({ env: { WEBTERM_RUN_REQUIRE_APPROVAL: 'on' } })
    await execTool(needsApproval.ctx, 'task.run', args)
    expect(store(needsApproval).listTasks({ projectId: 'p1' })).toEqual([])
    const stale = setup({ version: 9 })
    await execTool(stale.ctx, 'task.run', args)
    expect(store(stale).listTasks({ projectId: 'p1' })).toEqual([])
  })

  it('a failed run leaves a failed card', async () => {
    const s = setup({ run: () => outcome({ ok: false, error: { code: 'verify_failed', message: 'no' } }) })
    expect((await execTool(s.ctx, 'task.run', args)).ok).toBe(false)
    expect(store(s).listTasks({ projectId: 'p1' })[0]?.status).toBe('failed')
    expect(store(s).openAssignmentOfNode('run:i1')).toBeNull()
  })
})
