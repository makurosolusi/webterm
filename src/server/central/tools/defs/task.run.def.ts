// `task.run` (R2): central asks the server to run an already-assigned plan item through the worker
// runtime. It goes through `runTaskInProcess` -> `orchestratorRunRoute`, so the run flag, pause,
// plan, approval gate and verifier apply exactly as for POST /api/orchestrator/run. Wiring into the
// registry is done by the integrator (`createTaskRunDef` / `TASK_RUN_DEF`).
import { approvalDigest } from '../../../ledger/ledgerApproval'
import type { LedgerRuntime } from '../../../ledger/ledgerRuntime'
import { ORCHESTRATOR_RUN_FLAG, orchestratorRunEnabled, orchestratorRunRequireApproval } from '../../../orchestratorRunModel'
import type { OrchestratorRunDeps } from '../../../orchestratorRunProduction'
import { runTaskInProcess } from '../../../orchestrator/runTaskInProcess'
import type { ToolCtx, ToolDef, ToolInput, ToolResult } from '../toolTypes'

const SAFE_ID = /^[A-Za-z0-9._:-]+$/
const MAX_ID = 200
const ALLOWED_KEYS = new Set(['projectId', 'itemId', 'expectedVersion', 'approvalId'])
/** Action shape a human approves for a run; the digest is derived from it server-side, never from the model. */
export const RUN_APPROVAL_ACTION = 'worker.run'

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID && SAFE_ID.test(value)
}

/** Gerbang run yang sama dengan POST /api/orchestrator/run (workers on; approval default ON). */
export function runGateFlags(env: NodeJS.ProcessEnv): Pick<OrchestratorRunDeps, 'enabled' | 'requireApproval'> {
  return { enabled: orchestratorRunEnabled(env), requireApproval: orchestratorRunRequireApproval(env) }
}

/** Default deps: ledger facade over the tool's own db, flags from the tool env. */
async function defaultDeps(ctx: ToolCtx): Promise<OrchestratorRunDeps> {
  const { createLedger } = await import('../../../ledger/ledger')
  const env = ctx.env ?? process.env
  const ledger = { mode: 'on', path: '', db: ctx.db, ledger: createLedger(ctx.db, { now: Date.now }), close() {} } as unknown as LedgerRuntime
  return { ledger, ...runGateFlags(env) }
}

/** Builds the tool; `resolveDeps` is the injection point for sessions/worktrees/verifier and tests. */
export function createTaskRunDef(resolveDeps: (ctx: ToolCtx) => Promise<OrchestratorRunDeps> | OrchestratorRunDeps = defaultDeps): ToolDef {
  return {
    name: 'task.run',
    summary: 'Run an assigned plan item with a worker agent in its own worktree; server verifies the result.',
    tier: 'R2',
    flag: ORCHESTRATOR_RUN_FLAG,
    usage: '{"projectId":"<id>","itemId":"<assigned item>","expectedVersion":<plan version>,"approvalId":"<approved worker.run approval, only when required>"}. Item must already be assigned (task.assign). Never merges.',
    auditKeys: ['taskId', 'planVersion', 'nodeId'],
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
      const result = await runTaskInProcess(
        {
          projectId: projectId as string,
          itemId,
          expectedVersion: input.expectedVersion as number,
          ...(approvalId ? { approvalId, approvalDigest: approvalDigest({ action: RUN_APPROVAL_ACTION, projectId, itemId }) } : {}),
        },
        await resolveDeps(ctx)
      )
      if (!result.ok) return { ok: false, code: result.code }
      const { task, plan, nodeId } = result.outcome
      return { ok: true, data: { ...(task ? { taskId: task.id } : {}), ...(plan ? { planVersion: plan.version } : {}), ...(nodeId ? { nodeId } : {}) } }
    },
  }
}

/** Ready-to-register tool using production deps resolution. */
export const TASK_RUN_DEF: ToolDef = createTaskRunDef()
