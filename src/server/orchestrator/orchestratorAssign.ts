// assignTask: task dibuat di ledger lalu item plan dikunci ke task itu dalam satu transaksi.
// Assign adalah satu-satunya jalan masuk worktree: spawn hanya untuk item berstatus assigned.
import { assertProjectOwnership } from './roles'
import type {
  AssignTaskInput,
  AssignTaskValue,
  OrchestratorResult,
} from './orchestratorModel'
import {
  type OrchestratorContext,
  deny,
  planDeny,
  requireWorker,
  roleDeny,
  taskSpec,
} from './orchestratorSupport'

export function assignTask(
  ctx: OrchestratorContext,
  input: AssignTaskInput
): OrchestratorResult<AssignTaskValue> {
  const plan = ctx.deps.plan.get(input.projectId)
  if (!plan) return deny('plan_missing', `no plan for project ${input.projectId}`)
  const agent = ctx.deps.ledger.agent.getAgent(input.assignee)
  if (!agent) return deny('agent_not_found', `agent not found: ${input.assignee}`)
  try {
    assertProjectOwnership(input.projectId, agent)
  } catch (err) {
    return roleDeny(err)
  }
  const roleProblem = requireWorker(agent)
  if (roleProblem) return roleProblem
  const item = plan.items.find((candidate) => candidate.id === input.itemId)
  if (!item) return deny('item_not_found', `no item ${input.itemId} in plan for ${input.projectId}`)
  // Fail fast before createTask: the store still re-checks inside its transaction, but a
  // stale caller must not leave a task behind when no transaction rollback is available.
  if (plan.version !== input.expectedVersion) {
    return deny(
      'plan_stale',
      `plan for project ${input.projectId} is at version ${plan.version}, caller expected ${input.expectedVersion}`
    )
  }

  const tx = ctx.deps.ledger.tx ?? (<T,>(fn: () => T): T => fn())
  try {
    const value = tx(() => {
      const task = ctx.deps.ledger.task.createTask({
        projectId: input.projectId,
        spec: taskSpec(item),
        agentId: agent.id,
        idemKey: `plan:${plan.id}:${item.id}`,
        maxAttempts: input.maxAttempts,
      })
      const assigned = ctx.deps.plan.assign({
        projectId: input.projectId,
        itemId: item.id,
        taskId: task.id,
        assignee: agent.id,
        expectedVersion: input.expectedVersion,
      })
      ctx.deps.ledger.event.appendEvent({
        projectId: input.projectId,
        taskId: task.id,
        actor: input.actor ?? 'orchestrator',
        kind: 'orchestrator.task_assigned',
        payload: { itemId: item.id, assignee: agent.id, planVersion: assigned.version },
      })
      return {
        task,
        item: assigned.items.find((candidate) => candidate.id === item.id) ?? item,
        plan: assigned,
      }
    })
    return { ok: true, value }
  } catch (err) {
    return planDeny(err)
  }
}
