// In-process entry to the worker run (same path as POST /api/orchestrator/run), for server-side
// callers such as the `task.run` tool. It reuses `orchestratorRunRoute`, so every gate (flag,
// pause, plan, approval, caps, verifier) is unchanged; it only flattens the HTTP-shaped result.
import { createLogger } from '../logs'
import { createPlanStore } from './plan'
import type { WorkerRunOutcome } from './workerRuntimeTypes'
import { orchestratorRunRoute } from '../orchestratorRunApi'
import type { OrchestratorRunDeps } from '../orchestratorRunProduction'

const log = createLogger('orchestrator')

export interface RunTaskRequest {
  projectId: string
  itemId: string
  /** Plan version the caller saw; a newer plan answers `conflict` before any approval is spent. */
  expectedVersion: number
  approvalId?: string
  approvalDigest?: string
}

export type RunTaskResult =
  | { ok: true; outcome: WorkerRunOutcome }
  | { ok: false; code: string; status: number }

function codeOf(body: unknown): string {
  const record = (body ?? {}) as { error?: unknown; code?: unknown }
  if (typeof record.code === 'string') return record.code
  if (typeof record.error === 'string') return record.error
  const nested = (record.error as { code?: unknown } | undefined)?.code
  return typeof nested === 'string' ? nested : 'run_failed'
}

/** Runs one assigned plan item through the worker runtime; never throws. `plan_stale` maps to `conflict`. */
export async function runTaskInProcess(request: RunTaskRequest, deps: OrchestratorRunDeps): Promise<RunTaskResult> {
  try {
    // Optimistic concurrency up front: the route's own stale check runs after the approval is consumed.
    const plans = deps.planStore ?? (deps.ledger ? createPlanStore(deps.ledger.db) : null)
    const current = plans?.get(request.projectId)
    if (current && current.version !== request.expectedVersion) return { ok: false, code: 'conflict', status: 409 }
    // Central's task.run is the only in-process caller: its workers belong to central (K3 lineage).
    const result = await orchestratorRunRoute(request, { ...deps, spawnParent: 'central' })
    const body = result.body as { ok?: unknown; outcome?: WorkerRunOutcome }
    if (result.status === 200 && body.ok === true && body.outcome) return { ok: true, outcome: body.outcome }
    const code = codeOf(body)
    return { ok: false, code: code === 'plan_stale' ? 'conflict' : code, status: result.status }
  } catch {
    log.warn('orchestrator.run.inprocess', 'in-process run failed', { code: 'internal' })
    return { ok: false, code: 'internal', status: 500 }
  }
}
