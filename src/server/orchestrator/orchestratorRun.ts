// startWorker + recordWorkerResult: cap dicek sebelum spawn, worktree dialokasikan
// sebelum lease, dan hasil worker hanya diterima dengan fence + lease yang masih hidup.
import { checkCaps, emptyCapSnapshot, type CapSnapshot } from './caps'
import { ownsProject } from './roles'
import {
  type OrchestratorResult,
  type RecordWorkerResultInput,
  type RecordWorkerResultValue,
  type StartWorkerInput,
  type StartWorkerValue,
  type VerificationEvidence,
  evidenceVerified,
} from './orchestratorModel'
import {
  type OrchestratorContext,
  type OrchestratorTaskOutcome,
  deny,
  findItem,
  planDeny,
  releaseQuietly,
  requireWorker,
  worktreeDeny,
} from './orchestratorSupport'

export async function startWorker(
  ctx: OrchestratorContext,
  input: StartWorkerInput
): Promise<OrchestratorResult<StartWorkerValue>> {
  const plan = ctx.deps.plan.get(input.projectId)
  if (!plan) return deny('plan_missing', `no plan for project ${input.projectId}`)
  const item = plan.items.find((candidate) => candidate.id === input.itemId)
  if (!item) return deny('item_not_found', `no item ${input.itemId} in plan ${plan.id}`)
  if (item.status !== 'assigned' || item.taskId === null || item.assignee === null) {
    return deny('invalid_state', `item ${item.id} is ${item.status}; assign before spawn`)
  }
  const task = ctx.deps.ledger.task.getTask(item.taskId)
  if (!task) return deny('task_not_found', `task not found: ${item.taskId}`)
  if (task.projectId !== input.projectId) {
    return deny('project_mismatch', `task ${task.id} belongs to ${task.projectId}`)
  }
  const agent = ctx.deps.ledger.agent.getAgent(item.assignee)
  if (!agent) return deny('agent_not_found', `agent not found: ${item.assignee}`)
  if (!ownsProject(input.projectId, agent)) {
    return deny('project_mismatch', `agent ${agent.id} does not belong to ${input.projectId}`)
  }
  const roleProblem = requireWorker(agent)
  if (roleProblem) return roleProblem

  const snapshot: CapSnapshot = {
    ...emptyCapSnapshot(),
    ...input.usage,
    activeWorkers: plan.items.filter((candidate) => candidate.status === 'running').length,
    attemptsUsed: task.attempt,
  }
  const leaseMs = input.leaseMs ?? ctx.caps.leaseMs
  const decision = checkCaps(snapshot, { workers: 1, attempt: task.attempt + 1, leaseMs }, ctx.caps)
  if (!decision.ok) {
    return deny(
      'cap_denied',
      `caps blocked worker start: ${decision.denials.map((d) => d.code).join(', ')}`,
      decision.denials
    )
  }

  const branch = input.branch ?? `${ctx.branchPrefix}/${task.id}`
  let worktree
  try {
    worktree = await ctx.deps.worktrees.allocate({
      taskId: task.id,
      branch,
      repo: input.repo,
      owner: agent.id,
      baseRef: input.baseRef,
    })
  } catch (err) {
    return worktreeDeny(err)
  }

  const leased = ctx.deps.ledger.task.leaseTask(task.id, { owner: agent.id, ttlMs: leaseMs })
  if (!leased) {
    await releaseQuietly(ctx, task.id)
    return deny('lease_denied', `task ${task.id} could not be leased (attempt ${task.attempt})`)
  }

  try {
    const updated = ctx.deps.plan.updateItem({
      projectId: input.projectId,
      itemId: item.id,
      expectedVersion: input.expectedVersion,
      actor: agent.id,
      status: 'running',
    })
    ctx.deps.ledger.event.appendEvent({
      projectId: input.projectId,
      taskId: task.id,
      actor: agent.id,
      kind: 'orchestrator.worker_started',
      payload: { branch: worktree.branch, path: worktree.path, fence: leased.fence },
    })
    return {
      ok: true,
      value: {
        task: leased,
        worktree: { taskId: worktree.taskId, branch: worktree.branch, path: worktree.path },
        item: updated.items.find((candidate) => candidate.id === item.id) ?? item,
        plan: updated,
      },
    }
  } catch (err) {
    // Worktree disposable; task tetap leased sampai reaper bila plan gagal ditulis.
    await releaseQuietly(ctx, task.id)
    return planDeny(err)
  }
}

function claimSuccess(
  ctx: OrchestratorContext,
  taskId: string,
  fence: number,
  evidence: VerificationEvidence | undefined
): OrchestratorTaskOutcome {
  const claimed = ctx.deps.ledger.task.claimDone(taskId, fence, evidence)
  // Evidence tanpa test (atau test merah) berhenti di `claimed_done`, bukan `verified`.
  if (!evidenceVerified(evidence)) return { task: claimed, verified: false }
  return { task: ctx.deps.ledger.task.verifyTask(taskId, fence, evidence), verified: true }
}

export async function recordWorkerResult(
  ctx: OrchestratorContext,
  input: RecordWorkerResultInput
): Promise<OrchestratorResult<RecordWorkerResultValue>> {
  const task = ctx.deps.ledger.task.getTask(input.taskId)
  if (!task) return deny('task_not_found', `task not found: ${input.taskId}`)
  if (task.projectId !== input.projectId) {
    return deny('project_mismatch', `task ${task.id} belongs to ${task.projectId}`)
  }
  // Fence yang lebih tua berarti task sudah di-lease ulang; jangan sentuh apa pun.
  if (task.fence !== input.fence) {
    return deny(
      'stale_fence',
      `stale fence for task ${task.id}: caller ${input.fence}, row ${task.fence}`
    )
  }
  if (task.leaseOwner !== input.actor) {
    return deny(
      'lease_denied',
      `task ${task.id} is leased by ${task.leaseOwner ?? '<none>'}, not ${input.actor}`
    )
  }
  const plan = ctx.deps.plan.get(input.projectId)
  if (!plan) return deny('plan_missing', `no plan for project ${input.projectId}`)
  const item = findItem(plan, input.itemId, task.id)
  if (!item) return deny('item_not_found', `no plan item linked to task ${task.id}`)
  if (item.assignee !== input.actor || item.status !== 'running') {
    return deny(
      'not_participant',
      `item ${item.id} is ${item.status} for ${item.assignee ?? '<none>'}, caller ${input.actor}`
    )
  }

  let outcome: OrchestratorTaskOutcome
  try {
    outcome =
      input.outcome === 'success'
        ? claimSuccess(ctx, task.id, input.fence, input.evidence)
        : {
            task: ctx.deps.ledger.task.failTask(
              task.id,
              input.fence,
              input.reason ?? 'worker reported failure'
            ),
            verified: false,
          }
  } catch (err) {
    return planDeny(err)
  }

  const releaseError = await releaseQuietly(ctx, task.id)
  try {
    const nextStatus = outcome.verified ? 'done' : input.outcome === 'success' ? null : 'failed'
    const updated =
      nextStatus === null
        ? plan
        : ctx.deps.plan.updateItem({
            projectId: input.projectId,
            itemId: item.id,
            expectedVersion: input.expectedVersion,
            actor: input.actor,
            status: nextStatus,
          })
    ctx.deps.ledger.event.appendEvent({
      projectId: input.projectId,
      taskId: task.id,
      actor: input.actor,
      kind: 'orchestrator.result_recorded',
      payload: {
        outcome: input.outcome,
        status: outcome.task.status,
        verified: outcome.verified,
        releaseError,
      },
    })
    return {
      ok: true,
      value: {
        task: outcome.task,
        item: updated.items.find((candidate) => candidate.id === item.id) ?? item,
        plan: updated,
        verified: outcome.verified,
        ...(releaseError ? { releaseError } : {}),
      },
    }
  } catch (err) {
    return planDeny(err)
  }
}
