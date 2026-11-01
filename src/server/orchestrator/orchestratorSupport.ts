// Helper bersama orkestrator: mapping error -> deny bertipe, validasi worker, dan
// pembersihan worktree best-effort. Dipisah supaya tiap modul orkestrasi < 300 baris.
import { DEFAULT_CAPS, type CapLimits, type CapViolation } from './caps'
import { PlanError, type Plan, type PlanItem } from './plan'
import { RoleError, assertRoleDepth, isAgentRole } from './roles'
import { WorktreeError } from './worktree'
import type {
  OrchestratorAgent,
  OrchestratorDeny,
  OrchestratorDenyCode,
  OrchestratorDeps,
  OrchestratorTask,
} from './orchestratorModel'

export interface OrchestratorContext {
  deps: OrchestratorDeps
  caps: CapLimits
  branchPrefix: string
}

export interface OrchestratorTaskOutcome {
  task: OrchestratorTask
  verified: boolean
}

export function contextOf(deps: OrchestratorDeps): OrchestratorContext {
  return {
    deps,
    caps: deps.caps ?? DEFAULT_CAPS,
    branchPrefix: deps.branchPrefix ?? 'agent',
  }
}

export function deny(
  code: OrchestratorDenyCode,
  message: string,
  violations?: CapViolation[]
): OrchestratorDeny {
  return violations ? { ok: false, code, message, violations } : { ok: false, code, message }
}

/** PlanError -> kode deny publik; detail asli tetap di message. */
export function planDeny(err: unknown): OrchestratorDeny {
  if (!(err instanceof PlanError)) throw err
  const code: OrchestratorDenyCode =
    err.code === 'stale_version'
      ? 'plan_stale'
      : err.code === 'not_participant'
        ? 'not_participant'
        : err.code === 'item_not_found'
          ? 'item_not_found'
          : err.code === 'plan_not_found'
            ? 'plan_missing'
            : 'invalid_state'
  return deny(code, err.message)
}

export function roleDeny(err: unknown): OrchestratorDeny {
  if (!(err instanceof RoleError)) throw err
  const code: OrchestratorDenyCode =
    err.code === 'project_mismatch'
      ? 'project_mismatch'
      : err.code === 'max_depth'
        ? 'spawn_depth'
        : 'wrong_role'
  return deny(code, err.message)
}

export function worktreeDeny(err: unknown): OrchestratorDeny {
  if (!(err instanceof WorktreeError)) throw err
  return deny('worktree_failed', err.message)
}

/** Spec task = judul + scope, supaya worker tahu batas file yang boleh disentuh. */
export function taskSpec(item: PlanItem): string {
  const scope = item.scope.map((entry) => `- ${entry}`).join('\n')
  return `${item.title}\n\nScope:\n${scope}`
}

/** Hanya worker depth 2 (leaf) yang boleh di-assign. */
export function requireWorker(agent: OrchestratorAgent): OrchestratorDeny | null {
  if (!isAgentRole(agent.role)) return deny('wrong_role', `agent ${agent.id} has role ${agent.role}`)
  try {
    assertRoleDepth(agent.role, agent.depth)
  } catch (err) {
    return roleDeny(err)
  }
  if (agent.role !== 'worker' || agent.depth !== 2) {
    return deny(
      'wrong_role',
      `agent ${agent.id} is ${agent.role}/${agent.depth}; assign requires worker/2`
    )
  }
  return null
}

export function findItem(
  plan: Plan,
  itemId: string | undefined,
  taskId?: string
): PlanItem | undefined {
  if (itemId !== undefined) return plan.items.find((item) => item.id === itemId)
  return plan.items.find((item) => item.taskId === taskId)
}

/** Cleanup worktree yang tidak boleh menggagalkan hasil ledger yang sudah tercatat. */
export async function releaseQuietly(
  ctx: OrchestratorContext,
  taskId: string
): Promise<string | undefined> {
  try {
    await ctx.deps.worktrees.release({ taskId })
    return undefined
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
