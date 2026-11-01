// Titik masuk P3: komposisi assign/start/record di atas port yang di-inject.
// Tidak ada HTTP/UI wiring di sini; api.ts/index.ts cukup memanggil createOrchestrator.
import { assertCanSpawn, isAgentRole } from './roles'
import { assignTask } from './orchestratorAssign'
import { recordWorkerResult, startWorker } from './orchestratorRun'
import { contextOf, deny, roleDeny } from './orchestratorSupport'
import type {
  AssignTaskInput,
  AssignTaskValue,
  OrchestratorDeps,
  OrchestratorResult,
  RecordWorkerResultInput,
  RecordWorkerResultValue,
  SpawnDecision,
  StartWorkerInput,
  StartWorkerValue,
} from './orchestratorModel'

export * from './orchestratorModel'
export * from './roles'
export * from './caps'
export * from './plan'
export * from './worktree'

export interface Orchestrator {
  assignTask(input: AssignTaskInput): OrchestratorResult<AssignTaskValue>
  startWorker(input: StartWorkerInput): Promise<OrchestratorResult<StartWorkerValue>>
  recordWorkerResult(
    input: RecordWorkerResultInput
  ): Promise<OrchestratorResult<RecordWorkerResultValue>>
  /** Gerbang spawn berbasis role/depth; worker dan depth 3 ditolak. */
  canSpawn(agent: { role: string; depth: number }): SpawnDecision
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const ctx = contextOf(deps)

  function canSpawn(agent: { role: string; depth: number }): SpawnDecision {
    if (!isAgentRole(agent.role)) return deny('wrong_role', `unknown agent role: ${agent.role}`)
    try {
      return { ok: true, value: assertCanSpawn(agent.role, agent.depth) }
    } catch (err) {
      return roleDeny(err)
    }
  }

  return {
    assignTask: (input) => assignTask(ctx, input),
    startWorker: (input) => startWorker(ctx, input),
    recordWorkerResult: (input) => recordWorkerResult(ctx, input),
    canSpawn,
  }
}
