// `/api/dag` (F4-b). Reads are open behind the transport gate; every write is UI-only (the same gate as
// /api/approvals, `approvalAuth.ts`): an agent credential gets 403 before any DAG code runs, so no agent
// can create work for other agents or resolve a decision gate (Orca: only explicit human resolution).
//   GET  /api/dag[?limit=&offset=]           -> { dags }
//   GET  /api/dag/:id                        -> { dag, tasks, gates, dispatches, waves, estimate }
//   /api/dag/plan*                           -> drafts from an intent, never a dag (dag.plan.ts)
//   POST /api/dag  { projectId, title, repo, baseRef?, baseBranch?, tasks } -> 201 { dag, waves, estimate }
// `estimate`: cost-oracle median per worker run x agent tasks not done yet (null total = no history).
//   POST /api/dag/:id/tick                   -> { dag, tasks }
//   POST /api/dag/gates/:gateId/decide { approve, option? } -> { gate, task }
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { uiOnlyDenial } from '../approvalAuth'
import { actorForRequest } from '../approvalHumanShared'
import type { AppendEventInput } from '../events/eventModel'
import { actOnItem } from '../inbox/inboxActions'
import type { LedgerContext } from '../ledger/ledgerCore'
import { DagError, planWaves } from './dag.model'
import { handlePlanApi, planEstimate, type PlanDeps } from './dag.plan'
import type { DagScheduler } from './dag.scheduler'

export const DAG_PATH = '/api/dag'
export const DAG_BODY_MAX_BYTES = 256 * 1024
const TITLE_MAX = 200

export type DagResult = { status: number; body: unknown } | null

export interface DagApiDeps extends PlanDeps {
  ctx: LedgerContext
  scheduler: DagScheduler
  isNodeToken(token: string): boolean
  record(event: AppendEventInput): void
  /** Production: start the background poll after a write. */
  arm?(): void
}

const ours = (p: string): boolean => p === DAG_PATH || p.startsWith(`${DAG_PATH}/`)
const fail = (status: number, error: string, detail?: string): DagResult => ({ status, body: { error, ...(detail ? { detail } : {}) } })
const optText = (v: unknown, max: number): v is string | undefined => v === undefined || (typeof v === 'string' && v.trim() !== '' && v.length <= max)

function view(deps: DagApiDeps, id: string) {
  const s = deps.scheduler
  const dag = s.store.get(id)
  if (!dag) return null
  const tasks = s.store.tasks(id)
  return { dag, tasks, gates: s.store.gates(id), dispatches: s.store.dispatchesOf(id), waves: planWaves(tasks), estimate: planEstimate(deps.ctx, id, tasks) }
}

function create(deps: DagApiDeps, req: IncomingMessage, url: URL, body: Record<string, unknown>): DagResult {
  const { projectId, title, repo, baseRef, baseBranch } = body
  if (typeof projectId !== 'string' || !projectId) return fail(400, 'invalid_project_id')
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) return fail(400, 'invalid_title')
  if (typeof repo !== 'string' || !isAbsolute(repo)) return fail(400, 'invalid_repo', 'repo: absolute path of a git checkout')
  // Refs become git argv entries (never a shell); a leading '-' would still read as an option.
  if (!optText(baseRef, 200) || !optText(baseBranch, 200) || [baseRef, baseBranch].some((r) => typeof r === 'string' && (r.startsWith('-') || /[\s\0]/.test(r)))) {
    return fail(400, 'invalid_ref')
  }
  const dag = deps.scheduler.store.create({
    projectId, title: title.trim(), repo, createdBy: actorForRequest(req, url), tasks: body.tasks,
    ...(baseRef ? { baseRef } : {}), baseBranch: (baseBranch as string | undefined) ?? 'main',
  })
  deps.scheduler.created(dag)
  deps.arm?.()
  const tasks = deps.scheduler.store.tasks(dag.id)
  return { status: 201, body: { dag, waves: planWaves(tasks), estimate: planEstimate(deps.ctx, dag.id, tasks) } }
}

async function decide(deps: DagApiDeps, req: IncomingMessage, url: URL, gateId: string, body: Record<string, unknown>): Promise<DagResult> {
  const gate = deps.scheduler.store.gate(gateId)
  if (!gate) return fail(404, 'not_found')
  if (gate.status !== 'pending') return fail(409, 'not_pending', gate.status)
  if (typeof body.approve !== 'boolean') return fail(400, 'invalid_approve', 'approve: boolean')
  if (body.option !== undefined && (typeof body.option !== 'string' || !(gate.options ?? []).includes(body.option))) return fail(400, 'invalid_option')
  if (typeof body.option === 'string') deps.scheduler.store.setTask(gate.taskId, { decision: `${gate.question}: ${body.option}` })
  // The inbox item id is the approval id (createGate); deciding it is the same fact as the inbox/Telegram button.
  const acted = await actOnItem({
    ctx: deps.ctx, actor: actorForRequest(req, url), record: deps.record,
    outbox: () => Promise.reject(new Error('dag gate decisions never send mail')),
  }, gate.approvalId, { type: body.approve ? 'approve' : 'deny' })
  if (acted.status !== 200) return { status: acted.status, body: acted.body }
  await deps.scheduler.tick()
  deps.arm?.()
  return { status: 200, body: { gate: deps.scheduler.store.gate(gateId), task: deps.scheduler.store.task(gate.taskId) } }
}

/** Handles `/api/dag*`; null when the path is not ours. `body` is the parsed JSON of a POST. */
export async function handleDagApi(deps: DagApiDeps, req: IncomingMessage, url: URL, body: Record<string, unknown>): Promise<DagResult> {
  if (!ours(url.pathname)) return null
  const method = req.method ?? 'GET'
  let parts: string[]
  try {
    parts = url.pathname.slice(DAG_PATH.length).split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return fail(400, 'invalid_path')
  }
  if (method === 'GET') {
    if (parts[0] === 'plan') return handlePlanApi(deps, method, parts, body)
    if (parts.length === 0) {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      if (!Number.isInteger(limit) || !Number.isInteger(offset)) return fail(400, 'invalid_page')
      return { status: 200, body: { dags: deps.scheduler.store.list(limit, offset) } }
    }
    if (parts.length === 1) { const v = view(deps, parts[0]); return v ? { status: 200, body: v } : fail(404, 'not_found') }
    return fail(404, 'not_found')
  }
  if (method !== 'POST') return fail(405, 'method_not_allowed')
  const denial = uiOnlyDenial(req, url, deps.isNodeToken)
  if (denial) return fail(403, denial)
  try {
    if (parts[0] === 'plan') return handlePlanApi(deps, method, parts, body)
    if (parts.length === 0) return create(deps, req, url, body)
    if (parts.length === 2 && parts[1] === 'tick') {
      if (!deps.scheduler.store.get(parts[0])) return fail(404, 'not_found')
      await deps.scheduler.tick()
      return { status: 200, body: view(deps, parts[0]) }
    }
    if (parts.length === 3 && parts[0] === 'gates' && parts[2] === 'decide') return await decide(deps, req, url, parts[1], body)
    return fail(404, 'not_found')
  } catch (err) {
    if (err instanceof DagError) return fail(err.code === 'project_not_found' ? 404 : 400, err.code, err.message)
    throw err
  }
}
