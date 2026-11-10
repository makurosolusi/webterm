// `task.run` (R2): central asks the server to run an already-assigned plan item through the worker
// runtime. It goes through `runTaskInProcess` -> `orchestratorRunRoute`, so the run flag, pause,
// plan, approval gate and verifier apply exactly as for POST /api/orchestrator/run. Wiring into the
// registry is done by the integrator (`createTaskRunDef` / `TASK_RUN_DEF`).
import { approvalDigest } from '../../../ledger/ledgerApproval'
import type { LedgerRuntime } from '../../../ledger/ledgerRuntime'
import { ORCHESTRATOR_RUN_FLAG, orchestratorRunEnabled, orchestratorRunRequireApproval } from '../../../orchestratorRunModel'
import { approvalMissing, assignmentProblem, type OrchestratorRunDeps, projectRepo } from '../../../orchestratorRunProduction'
import { createPlanStore } from '../../../orchestrator/plan'
import { type RunTaskRequest, runTaskInProcess } from '../../../orchestrator/runTaskInProcess'
import { beginDelegation, type Delegation, type DelegationResult, settleSend } from '../../work/workDelegation'
import { createWorkStore } from '../../work/workStore'
import { createWorkVerifier } from '../../work/workVerify'
import type { ToolCtx, ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'

const SAFE_ID = /^[A-Za-z0-9._:-]+$/
const MAX_ID = 200
const ALLOWED_KEYS = new Set(['projectId', 'itemId', 'expectedVersion', 'approvalId'])
/** Action shape a human approves for a run; the digest is derived from it server-side, never from the model. */
export const RUN_APPROVAL_ACTION = 'worker.run'
const RUN_FINISHED_RULE = 'run_finished'
const runNodeId = (itemId: string): string => `run:${itemId}`

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID && SAFE_ID.test(value)
}

/** Gerbang run yang sama dengan POST /api/orchestrator/run (workers on; approval default ON, off under Skip approvals). */
export function runGateFlags(env: NodeJS.ProcessEnv, skipApprovals = false): Pick<OrchestratorRunDeps, 'enabled' | 'requireApproval'> {
  return { enabled: orchestratorRunEnabled(env), requireApproval: !skipApprovals && orchestratorRunRequireApproval(env) }
}

/** Default deps: ledger facade over the tool's own db, flags from the tool env. */
async function defaultDeps(ctx: ToolCtx): Promise<OrchestratorRunDeps> {
  const { createLedger } = await import('../../../ledger/ledger')
  const env = ctx.env ?? process.env
  const ledger = { mode: 'on', path: '', db: ctx.db, ledger: createLedger(ctx.db, { now: Date.now }), close() {} } as unknown as LedgerRuntime
  return { ledger, ...runGateFlags(env, ctx.guard.skipsApprovals?.() === true) }
}

/**
 * Records the run before it starts, or null when the route will refuse it and nothing runs. The worker's node only
 * exists once the blocking run has ended, so the assignment is keyed by the plan item, the only id known up front.
 */
function delegateRun(ctx: ToolCtx, deps: OrchestratorRunDeps, request: RunTaskRequest): DelegationResult | null {
  const plans = deps.planStore ?? (deps.ledger ? createPlanStore(deps.ledger.db) : null)
  if (!plans || assignmentProblem(plans, request.projectId, request.itemId) !== null || approvalMissing(deps, request)) return null
  const plan = plans.get(request.projectId)
  const item = plan?.version === request.expectedVersion ? plan.items.find((i) => i.id === request.itemId) : undefined
  if (!item) return null
  return beginDelegation(createWorkStore(ctx.db, ctx.now), {
    projectId: request.projectId, nodeId: runNodeId(request.itemId), channel: 'run', instruction: item.title, conversationId: ctx.conversationId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
  })
}

/** A blocking run emits no hook on its `run:` key, so its return is the only finish signal the card will ever get. */
async function reportRun(ctx: ToolCtx, { taskId, assignmentId }: Delegation, result: Record<string, unknown>): Promise<void> {
  const store = createWorkStore(ctx.db, ctx.now)
  const status = store.getTask(taskId)?.status
  // `stalled` is the startup rule firing during a run that outlived it; any other status means the card moved on.
  if (store.openAssignmentOfTask(taskId)?.id !== assignmentId || (status !== 'assigned' && status !== 'stalled')) return
  const actor = { kind: 'system' } as const
  store.moveTask(taskId, 'running', { actor, rule: RUN_FINISHED_RULE, assignmentId })
  store.moveTask(taskId, 'reported', { actor, rule: RUN_FINISHED_RULE, assignmentId })
  store.endAssignment(assignmentId, RUN_FINISHED_RULE, result, { actor, rule: RUN_FINISHED_RULE })
  // ponytail: per-call verifier, so a card edited to project_checks mid-run skips the per-project check queue; share the process verifier if that ever matters.
  await createWorkVerifier({ store, now: ctx.now, cwdOf: (id) => projectRepo(ctx.db, id) }).run(taskId)
}

/** Builds the tool; `resolveDeps` is the injection point for sessions/worktrees/verifier and tests. */
export function createTaskRunDef(resolveDeps: (ctx: ToolCtx) => Promise<OrchestratorRunDeps> | OrchestratorRunDeps = defaultDeps): ToolDef {
  return {
    name: 'task.run',
    summary: 'Run an assigned plan item with a worker agent in its own worktree; server verifies the result.',
    tier: 'R2',
    flag: ORCHESTRATOR_RUN_FLAG,
    usage: '{"projectId":"<id>","itemId":"<assigned item>","expectedVersion":<plan version>,"approvalId":"<approved worker.run approval, only when required>"}. Item must already be assigned from its plan in webterm. Tracked as a delegation. Never merges.',
    input: obj({ itemId: S.str(MAX_ID), expectedVersion: S.int(1), approvalId: S.str(MAX_ID) }, ['itemId', 'expectedVersion']),
    output: S.keys('taskId', 'planVersion', 'nodeId', 'workTaskId', 'assignmentId'),
    auditKeys: ['taskId', 'planVersion', 'nodeId', 'workTaskId', 'assignmentId'],
    validate: (input: ToolInput) => {
      const { itemId, expectedVersion, approvalId } = input
      const ok = Object.keys(input).every((key) => ALLOWED_KEYS.has(key)) && safeId(itemId)
        && Number.isSafeInteger(expectedVersion) && (expectedVersion as number) >= 1
        && (approvalId === undefined || safeId(approvalId))
      return ok ? null : 'invalid_shape'
    },
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const itemId = input.itemId as string
      const approvalId = input.approvalId as string | undefined
      const deps = await resolveDeps(ctx)
      const request: RunTaskRequest = {
        projectId: projectId as string,
        itemId,
        expectedVersion: input.expectedVersion as number,
        ...(approvalId ? { approvalId, approvalDigest: approvalDigest({ action: RUN_APPROVAL_ACTION, projectId, itemId }) } : {}),
      }
      const heldBefore = createWorkStore(ctx.db, ctx.now).openAssignmentOfNode(runNodeId(itemId))?.id
      const delegation = delegateRun(ctx, deps, request)
      if (delegation && !delegation.ok) return { ok: false, code: delegation.code, data: delegation.data }
      const run = (): ReturnType<typeof runTaskInProcess> => runTaskInProcess(request, deps)
      const result = delegation ? await settleSend(delegation, run, (r) => (r.ok ? null : r.code)) : await run()
      if (!result.ok) return { ok: false, code: result.code }
      const { task, plan, nodeId } = result.outcome
      const ids = { ...(task ? { taskId: task.id } : {}), ...(plan ? { planVersion: plan.version } : {}), ...(nodeId ? { nodeId } : {}) }
      if (delegation && delegation.assignmentId !== heldBefore) await reportRun(ctx, delegation, ids)
      const work = delegation ? { workTaskId: delegation.taskId, assignmentId: delegation.assignmentId } : {}
      return { ok: true, data: { ...ids, ...work } }
    },
  }
}

/** Ready-to-register tool using production deps resolution. */
export const TASK_RUN_DEF: ToolDef = createTaskRunDef()
