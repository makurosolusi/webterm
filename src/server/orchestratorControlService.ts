// Composition layer for the root-only orchestrator control plane: gating, transaction handling,
// plan/ledger lookups and error mapping. Transport authorization (root token / loopback) already
// happened in api.ts, so agents and nodes cannot reach these paths. A real worker spawn still
// needs the real CLI; assign only creates the ledger task and locks the plan item to it.
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { Agent, CreateAgentInput, CreateProjectInput, Project } from './ledger/ledgerModel'
import { PlanError, createPlanStore, type Plan, type PlanStore } from './orchestrator/plan'
import { assignTask } from './orchestrator/orchestratorAssign'
import { contextOf } from './orchestrator/orchestratorSupport'
import type { AssignTaskInput, OrchestratorDenyCode, OrchestratorLedger } from './orchestrator/orchestratorModel'
import type { WorktreeService } from './orchestrator/worktree'
import { orchestratorRunEnabled, type RouteResult } from './orchestratorRunApi'
import { LEDGER_OFF } from './apiShared.types'
import {
  ControlError,
  defaultIsGitRoot,
  parseAssignBody,
  parseBootstrapBody,
  type BootstrapInput,
} from './orchestratorControlModel'

/** Narrow slice of the real ledger this route needs; the facade satisfies it structurally. */
export interface ControlLedger extends OrchestratorLedger {
  project: { getProject(id: string): Project | null; createProject(input: CreateProjectInput): Project }
  agent: OrchestratorLedger['agent'] & { createAgent(input: CreateAgentInput): Agent }
}

export interface OrchestratorControlDeps {
  ledger: LedgerRuntime | null
  /** Defaults to the `workers` capability (isEnabled); tests may pin it. */
  enabled?: boolean
  /** Test seam; production uses `ledger.ledger`. */
  ledgerPort?: ControlLedger
  /** Test seam; production derives the store from `ledger.db`. */
  plan?: Pick<PlanStore, 'get' | 'create' | 'assign'>
  /** Test seam: path must be an absolute directory that is a git worktree root. */
  isGitRoot?: (path: string) => boolean
}

/** Assign never allocates a worktree (spawn does), so the stubs throw to expose any drift. */
const UNUSED_WORKTREES = {
  allocate: async () => { throw new Error('assign does not allocate worktrees') },
  release: async () => { throw new Error('assign does not release worktrees') },
  get: () => undefined,
  list: () => [],
} as unknown as WorktreeService

function gate(deps: OrchestratorControlDeps): RouteResult | null {
  if (!(deps.enabled ?? orchestratorRunEnabled())) return { status: 503, body: { error: 'orchestrator_off' } }
  if (!deps.ledger) return LEDGER_OFF
  return null
}

function portOf(deps: OrchestratorControlDeps): ControlLedger {
  return deps.ledgerPort ?? (deps.ledger?.ledger as ControlLedger)
}

function planOf(deps: OrchestratorControlDeps): Pick<PlanStore, 'get' | 'create' | 'assign'> {
  return deps.plan ?? createPlanStore(deps.ledger!.db)
}

function inTx<T>(port: ControlLedger, fn: () => T): T {
  return port.tx ? port.tx(fn) : fn()
}
/** Any failure inside the transaction rolls back project + both agents + plan as one unit. */
function bootstrapTx(port: ControlLedger, plan: Pick<PlanStore, 'create'>, req: BootstrapInput) {
  if (port.project.getProject(req.projectId) !== null) throw new ControlError(409, 'project_exists')
  const project = port.project.createProject({
    id: req.projectId, workspaceId: `bootstrap:${req.projectId}`, name: req.name, path: req.path,
    branchBase: req.branchBase,
  })
  const orchestrator = port.agent.createAgent({
    id: `orch:${req.projectId}`, projectId: req.projectId, name: `orchestrator:${req.projectId}`,
    role: 'orchestrator', depth: 1,
  })
  const worker = port.agent.createAgent({
    id: `worker:${req.projectId}`, projectId: req.projectId, parentAgentId: orchestrator.id,
    name: `worker:${req.projectId}`, role: 'worker', depth: 2,
  })
  const created: Plan = plan.create({ projectId: req.projectId, status: 'active', items: req.items })
  return { project, orchestrator, worker, plan: created }
}

function failure(err: unknown): RouteResult {
  if (err instanceof ControlError) return { status: err.status, body: { error: err.code } }
  if (err instanceof PlanError) {
    return { status: err.code === 'plan_exists' ? 409 : 400, body: { error: err.code } }
  }
  const message = err instanceof Error ? err.message : String(err)
  // Duplicate key races: the explicit project check can lose to a concurrent bootstrap.
  if (/already has a ledger project|UNIQUE constraint failed: (project|agent)\.(workspace_id|id)/.test(message)) {
    return { status: 409, body: { error: 'project_exists' } }
  }
  if (/duplicate task idem_key/.test(message)) return { status: 409, body: { error: 'invalid_state' } }
  if (/no such table: plan/i.test(message)) return { status: 503, body: { error: 'plan_unavailable' } }
  // Never echo the exception: it can quote absolute paths or ledger internals.
  return { status: 500, body: { error: 'internal' } }
}

const DENY_400: readonly OrchestratorDenyCode[] = ['agent_not_found', 'wrong_role', 'project_mismatch']

/** POST /api/orchestrator/bootstrap. Creates project + orchestrator + worker + plan atomically. */
export async function bootstrapControl(
  body: unknown,
  deps: OrchestratorControlDeps
): Promise<RouteResult> {
  const off = gate(deps)
  if (off) return off
  const parsed = parseBootstrapBody(body, deps.isGitRoot ?? defaultIsGitRoot)
  if (!parsed.ok) return parsed.result
  try {
    const port = portOf(deps)
    const built = inTx(port, () => bootstrapTx(port, planOf(deps), parsed.value))
    const { project, orchestrator, worker, plan } = built
    return {
      status: 200,
      body: {
        ok: true,
        project: { id: project.id, workspaceId: project.workspaceId, name: project.name, path: project.path },
        orchestratorAgentId: orchestrator.id,
        workerAgentId: worker.id,
        plan: {
          id: plan.id,
          version: plan.version,
          items: plan.items.map((i) => ({ id: i.id, seq: i.seq, title: i.title, scope: i.scope, status: i.status })),
        },
      },
    }
  } catch (err) {
    return failure(err)
  }
}

/** POST /api/orchestrator/assign. Creates the ledger task and locks the plan item to it. */
export async function assignControl(
  body: unknown,
  deps: OrchestratorControlDeps
): Promise<RouteResult> {
  const off = gate(deps)
  if (off) return off
  const parsed = parseAssignBody(body)
  if (!parsed.ok) return parsed.result
  const request = parsed.value
  try {
    const port = portOf(deps)
    const plan = planOf(deps)
    if (plan.get(request.projectId) === null) return { status: 409, body: { ok: false, error: 'plan_missing' } }
    const item = plan.get(request.projectId)?.items.find((i) => i.id === request.itemId)
    if (item === undefined) return { status: 409, body: { ok: false, error: 'item_not_found' } }
    if (item.status !== 'pending' || item.taskId !== null) return { status: 409, body: { ok: false, error: 'invalid_state' } }
    const ctx = contextOf({
      ledger: port,
      // assignTask only reads `get`/`assign`; the store is narrowed for the control surface.
      plan: plan as unknown as PlanStore,
      worktrees: UNUSED_WORKTREES,
    })
    const input: AssignTaskInput = {
      projectId: request.projectId, itemId: request.itemId, assignee: request.assignee,
      expectedVersion: request.expectedVersion, actor: 'orchestrator-control',
    }
    const outcome = assignTask(ctx, input)
    if (outcome.ok) {
      return { status: 200, body: { ok: true, taskId: outcome.value.task.id, planVersion: outcome.value.plan.version } }
    }
    return {
      status: DENY_400.includes(outcome.code) ? 400 : 409,
      body: { ok: false, error: outcome.code, message: outcome.message },
    }
  } catch (err) {
    return failure(err)
  }
}
