// Root-only orchestrator control plane: POST /api/orchestrator/bootstrap and
// POST /api/orchestrator/assign. `/run` requires an already-assigned item, so without these
// routes the production loop could only be exercised by a throwaway Bun script.
// Owns metadata only (project/agents/plan/task): no command, no worktree, no spawn. Transport
// authorization (root token / loopback) already happened in api.ts, so agents and nodes cannot
// reach these paths. A real worker spawn still needs the real CLI.
// Parsing lives in orchestratorControlModel; composition in orchestratorControlService.
import type { RouteResult } from './orchestratorRunApi'
import { assignControl, bootstrapControl, type OrchestratorControlDeps } from './orchestratorControlService'

export const ORCHESTRATOR_BOOTSTRAP_PATH = '/api/orchestrator/bootstrap'
export const ORCHESTRATOR_ASSIGN_PATH = '/api/orchestrator/assign'

export type { ControlLedger, OrchestratorControlDeps } from './orchestratorControlService'
export {
  defaultIsGitRoot,
  parseAssignBody,
  parseBootstrapBody,
  type AssignInput,
  type BootstrapInput,
  type BootstrapItem,
} from './orchestratorControlModel'

/** POST /api/orchestrator/bootstrap. Creates project + orchestrator + worker + plan atomically. */
export async function orchestratorBootstrapRoute(
  body: unknown,
  deps: OrchestratorControlDeps
): Promise<RouteResult> {
  return bootstrapControl(body, deps)
}

/** POST /api/orchestrator/assign. Creates the ledger task and locks the plan item to it. */
export async function orchestratorAssignRoute(
  body: unknown,
  deps: OrchestratorControlDeps
): Promise<RouteResult> {
  return assignControl(body, deps)
}
