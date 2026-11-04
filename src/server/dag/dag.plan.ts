// `/api/dag/plan*` (F4-f): draft a DAG from an intent, preview an edited draft. Nothing here creates a
// dag row or a worker; approval is the separate `POST /api/dag`. Writes are UI-only like the rest of
// `/api/dag` (checked by the caller), so no agent can make the planner spend for it.
//   POST /api/dag/plan          { intent, workspaceId } -> 202 { planId }
//   GET  /api/dag/plan/:planId  -> { status: 'drafting' } | { status: 'ready', draft, waves, estimate, projectId, repo } | { status: 'failed', error }
//   POST /api/dag/plan/preview  { title, tasks }        -> { draft, waves, estimate }   (400 with the validation error)
// Drafts live in memory: the Plan node copies a ready draft into its own (persisted) data, so a restart
// only loses a draft still being written, and the node offers to draft again.
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { lookupWorkspace, type WorkspaceRecord } from '../central/workspaceLookup'
import { estimateCost, type Estimate } from '../cost/costOracle'
import { getRow, newId } from '../ledger/ledgerCore'
import { projectRepository } from '../ledger/ledgerEntity'
import { createLogger } from '../logs'
import type { LedgerContext } from '../ledger/ledgerCore'
import { DagError, planWaves, type DagTask } from './dag.model'
import { INTENT_MAX, livePlanner, validateDraft, type PlanDraft, type Planner } from './dag.planner'

const log = createLogger('dag')
/** Drafts kept in memory; the oldest is dropped past this (a draft is read once by its node). */
export const PLAN_JOBS_MAX = 50

export interface PlanDeps {
  ctx: LedgerContext
  /** Defaults to the headless Claude Code planner; tests pass a fake (never a real Claude). */
  planner?: Planner
  /** Defaults to the canvas workspace store. */
  workspace?: (id: string) => WorkspaceRecord | null
}

export interface DagEstimate extends Estimate { tasks: number; totalMicros: number | null }

/** Plan estimate: every agent task still to run is one cost run of scope `dag:<id>` (a draft has no id yet: kind median). */
export function planEstimate(ctx: LedgerContext, dagId: string, tasks: ReadonlyArray<Pick<DagTask, 'kind'> & { status?: DagTask['status'] }>): DagEstimate {
  const per = estimateCost(ctx.db, { kind: 'dag', ref: dagId })
  const n = tasks.filter((t) => t.kind !== 'gate' && t.status !== 'done').length
  return { ...per, tasks: n, totalMicros: per.medianMicros === null ? null : per.medianMicros * n }
}

type Job =
  | { status: 'drafting' }
  | { status: 'ready'; draft: PlanDraft; waves: string[][]; estimate: DagEstimate; projectId: string; repo: string }
  | { status: 'failed'; error: string }

const jobs = new Map<string, Job>()

type Result = { status: number; body: unknown }
const fail = (status: number, error: string, detail?: string): Result => ({ status, body: { error, ...(detail ? { detail } : {}) } })

function ready(ctx: LedgerContext, draft: PlanDraft) {
  return { draft, waves: planWaves(draft.tasks), estimate: planEstimate(ctx, '', draft.tasks) }
}

/** The ledger project of a canvas workspace (id = workspace id), created on first use like costCapture does. */
function projectOf(ctx: LedgerContext, ws: WorkspaceRecord & { id: string }): string {
  const row = getRow(ctx.db, 'SELECT id FROM project WHERE id = ? OR workspace_id = ?', ws.id, ws.id)
  if (row) return String(row['id'])
  return projectRepository(ctx).createProject({ id: ws.id, workspaceId: ws.id, name: ws.name, path: ws.cwd || homedir() }).id
}

function start(deps: PlanDeps, body: Record<string, unknown>): Result {
  const { intent, workspaceId } = body
  if (typeof intent !== 'string' || !intent.trim() || intent.length > INTENT_MAX) return fail(400, 'invalid_intent', `intent: 1..${INTENT_MAX} chars`)
  if (typeof workspaceId !== 'string' || !workspaceId) return fail(400, 'invalid_workspace_id')
  const ws = (deps.workspace ?? lookupWorkspace)(workspaceId)
  if (!ws) return fail(404, 'workspace_not_found')
  if (!ws.cwd || !isAbsolute(ws.cwd)) return fail(400, 'invalid_repo', 'the workspace needs an absolute folder to plan in')
  const repo = ws.cwd
  const projectId = projectOf(deps.ctx, { ...ws, id: workspaceId })
  const planId = newId()
  jobs.set(planId, { status: 'drafting' })
  while (jobs.size > PLAN_JOBS_MAX) jobs.delete(jobs.keys().next().value as string)
  void (deps.planner ?? livePlanner)({ intent: intent.trim(), repo })
    .then((raw) => { jobs.set(planId, { status: 'ready', ...ready(deps.ctx, validateDraft(raw)), projectId, repo }) })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      log.warn('dag.plan.failed', `plan draft ${planId} failed`, { cause: error })
      jobs.set(planId, { status: 'failed', error })
    })
  return { status: 202, body: { planId } }
}

/** `parts` = path after `/api/dag`; null when not a plan route. POST callers already passed the UI-only gate. */
export function handlePlanApi(deps: PlanDeps, method: string, parts: string[], body: Record<string, unknown>): Result | null {
  if (parts[0] !== 'plan') return null
  if (method === 'GET' && parts.length === 2) {
    const job = jobs.get(parts[1])
    return job ? { status: 200, body: job } : fail(404, 'not_found')
  }
  if (method !== 'POST') return fail(405, 'method_not_allowed')
  if (parts.length === 1) return start(deps, body)
  if (parts.length === 2 && parts[1] === 'preview') {
    try {
      return { status: 200, body: ready(deps.ctx, validateDraft(body)) }
    } catch (err) {
      if (err instanceof DagError) return fail(400, err.code, err.message)
      throw err
    }
  }
  return fail(404, 'not_found')
}
