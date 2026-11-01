// Root-only orchestrator control plane: POST /api/orchestrator/bootstrap and
// POST /api/orchestrator/assign. `/run` requires an already-assigned item, so without these
// routes the production loop could only be exercised by a throwaway Bun script.
// Owns metadata only (project/agents/plan/task): no command, no worktree, no spawn. Transport
// authorization (root token / loopback) already happened in api.ts, so agents and nodes cannot
// reach these paths. A real worker spawn still needs the real CLI.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import type { Agent, CreateAgentInput, CreateProjectInput, Project } from './ledger/ledgerModel'
import { PlanError, createPlanStore, validateScope, type Plan, type PlanStore } from './orchestrator/plan'
import { assignTask } from './orchestrator/orchestratorAssign'
import { contextOf } from './orchestrator/orchestratorSupport'
import type { AssignTaskInput, OrchestratorDenyCode, OrchestratorLedger } from './orchestrator/orchestratorModel'
import type { WorktreeService } from './orchestrator/worktree'
import { orchestratorRunEnabled, type RouteResult } from './orchestratorRunApi'

export const ORCHESTRATOR_BOOTSTRAP_PATH = '/api/orchestrator/bootstrap'
export const ORCHESTRATOR_ASSIGN_PATH = '/api/orchestrator/assign'

const MAX_ID_CHARS = 200
const MAX_NAME_CHARS = 200
const MAX_PATH_CHARS = 4096
const MAX_ITEMS = 20
const MAX_ITEM_TITLE = 200
const MAX_ITEM_SCOPE = 20
const MAX_BRANCH_BASE = 200
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Agent ids are namespaced (`orch:<project>`, `worker:<project>`), so `:` is allowed. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** Everything a control body must not carry; `path` is bootstrap's own field, checked per route. */
const CLIENT_FIELDS = ['cmd', 'command', 'args', 'argv', 'exec', 'shell', 'repo', 'path', 'cwd', 'agent', 'agentId'] as const

/** Narrow slice of the real ledger this route needs; the facade satisfies it structurally. */
export interface ControlLedger extends OrchestratorLedger {
  project: { getProject(id: string): Project | null; createProject(input: CreateProjectInput): Project }
  agent: OrchestratorLedger['agent'] & { createAgent(input: CreateAgentInput): Agent }
}

export interface OrchestratorControlDeps {
  ledger: LedgerRuntime | null
  /** Defaults to the `WEBTERM_ORCHESTRATOR_RUN` flag; tests may pin it. */
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

class ControlError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'ControlError'
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) return null
  if (CONTROL_CHARS.test(value)) return null
  return value.trim()
}

function id(value: unknown): string | null {
  const parsed = text(value, MAX_ID_CHARS)
  return parsed !== null && ID_PATTERN.test(parsed) ? parsed : null
}

function agentId(value: unknown): string | null {
  const parsed = text(value, MAX_ID_CHARS)
  return parsed !== null && AGENT_ID_PATTERN.test(parsed) ? parsed : null
}

function invalid(error: string): { ok: false; result: RouteResult } {
  return { ok: false, result: { status: 400, body: { error } } }
}

export interface BootstrapItem { title: string; scope: string[] }

export interface BootstrapInput {
  projectId: string; name: string; path: string; items: BootstrapItem[]; branchBase?: string
}

/** `.git` may be a directory (normal clone) or a file (worktree/submodule pointer). */
function defaultIsGitRoot(path: string): boolean {
  try { return statSync(path).isDirectory() && existsSync(join(path, '.git')) } catch { return false }
}

function parseItems(raw: unknown): BootstrapItem[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) return 'invalid_items'
  const items: BootstrapItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'invalid_items'
    const item = entry as Record<string, unknown>
    const title = text(item['title'], MAX_ITEM_TITLE)
    if (title === null) return 'invalid_item_title'
    if (!Array.isArray(item['scope']) || item['scope'].length === 0 || item['scope'].length > MAX_ITEM_SCOPE) {
      return 'invalid_scope'
    }
    try {
      items.push({ title, scope: validateScope(item['scope']) })
    } catch (err) {
      if (!(err instanceof PlanError)) throw err
      return 'invalid_scope'
    }
  }
  return items
}

/** Validates a bootstrap payload; `path` is checked against the filesystem, never trusted. */
export function parseBootstrapBody(
  body: unknown,
  isGitRoot: (path: string) => boolean = defaultIsGitRoot
): { ok: true; value: BootstrapInput } | { ok: false; result: RouteResult } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('invalid_body')
  const raw = body as Record<string, unknown>
  for (const field of CLIENT_FIELDS) if (field !== 'path' && field in raw) return invalid('client_controlled_field')
  const projectId = id(raw['projectId'])
  if (projectId === null) return invalid('invalid_project_id')
  const name = text(raw['name'], MAX_NAME_CHARS)
  if (name === null) return invalid('invalid_name')
  const path = raw['path']
  if (
    typeof path !== 'string' || path === '' || path.length > MAX_PATH_CHARS ||
    path !== path.trim() || CONTROL_CHARS.test(path) || !isAbsolute(path) || !isGitRoot(path)
  ) {
    return invalid('invalid_path')
  }
  const items = parseItems(raw['items'])
  if (typeof items === 'string') return invalid(items)
  let branchBase: string | undefined
  if (raw['branchBase'] !== undefined) {
    const ref = text(raw['branchBase'], MAX_BRANCH_BASE)
    if (ref === null || ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
      return invalid('invalid_branch_base')
    }
    branchBase = ref
  }
  return { ok: true, value: { projectId, name, path, items, branchBase } }
}

export interface AssignInput {
  projectId: string; itemId: string; expectedVersion: number; assignee: string
}

/** Default assignee is the deterministic worker id created by bootstrap. */
export function parseAssignBody(
  body: unknown
): { ok: true; value: AssignInput } | { ok: false; result: RouteResult } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('invalid_body')
  const raw = body as Record<string, unknown>
  for (const field of CLIENT_FIELDS) if (field in raw) return invalid('client_controlled_field')
  const projectId = id(raw['projectId'])
  if (projectId === null) return invalid('invalid_project_id')
  const itemId = id(raw['itemId'])
  if (itemId === null) return invalid('invalid_item_id')
  const version = raw['expectedVersion']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return invalid('invalid_expected_version')
  }
  const assignee = raw['assignee'] === undefined ? `worker:${projectId}` : agentId(raw['assignee'])
  if (assignee === null) return invalid('invalid_assignee')
  return { ok: true, value: { projectId, itemId, expectedVersion: version, assignee } }
}

function gate(deps: OrchestratorControlDeps): RouteResult | null {
  if (!(deps.enabled ?? orchestratorRunEnabled())) return { status: 503, body: { error: 'orchestrator_off' } }
  if (!deps.ledger) return { status: 503, body: { error: 'ledger_off' } }
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
export async function orchestratorBootstrapRoute(
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
export async function orchestratorAssignRoute(
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
