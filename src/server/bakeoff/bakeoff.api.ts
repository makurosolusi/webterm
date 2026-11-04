// HTTP binding of bakeoff.service.ts, `{status, body} | null` like workspaceWorktree.route.ts.
//
//   GET  /api/bakeoff                      recent bake-offs (newest first)
//   GET  /api/bakeoff/:id                  one bake-off with its candidate cards
//   POST /api/bakeoff {repo, prompt, count, workspaceId?}    start: worktrees + headless agents
//   POST /api/bakeoff/:id/pick {candidateId}                 choose the winner (commits its tree)
//   POST /api/bakeoff/:id/merge                              merge the winner into the workspace
//   POST /api/bakeoff/:id/cleanup {confirm?}                 409 needs_confirm until confirm: true
//
// Every POST spawns agents or changes checkouts, so it is human-UI only (`uiOnlyDenial`): an agent
// credential gets 403, as for worktree workspaces.
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { WorktreeError } from '../orchestrator/worktree'
import { BakeoffError, type BakeoffService } from './bakeoff.service'

export const BAKEOFF_PATH = '/api/bakeoff'
export const BAKEOFF_BODY_MAX_BYTES = 64 * 1024

type Result = { status: number; body: unknown } | null
const STATUS: Record<BakeoffError['code'], number> = {
  bad_request: 400, not_found: 404, wrong_state: 409, base_moved: 409, dirty_repo: 409, merge_conflict: 409, git_failed: 500, cost_cap: 429,
}
const WT_STATUS: Partial<Record<WorktreeError['code'], number>> = { branch_in_use: 409, not_found: 404, git_failed: 500 }
const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })

export interface BakeoffApiDeps { service: BakeoffService; isNodeToken: (token: string) => boolean }

export async function handleBakeoffApi(deps: BakeoffApiDeps, req: IncomingMessage, url: URL, body: () => Promise<string>): Promise<Result> {
  const path = url.pathname
  if (path !== BAKEOFF_PATH && !path.startsWith(`${BAKEOFF_PATH}/`)) return null
  const [id, verb, ...rest] = path.slice(BAKEOFF_PATH.length + 1).split('/').filter(Boolean)
  if (rest.length > 0) return null
  const method = req.method ?? 'GET'
  const svc = deps.service
  try {
    if (method === 'GET') {
      if (verb) return null
      return { status: 200, body: id ? svc.get(id) : { bakeoffs: svc.list() } }
    }
    if (method !== 'POST') return null
    const denial = uiOnlyDenial(req, url, deps.isNodeToken)
    if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_run_bakeoff' : denial, message: 'Bake-offs are started and decided by the human at the webterm UI only.' } }
    const raw = await body() // BodyReadError (too large) propagates to the route: 413
    let b: Record<string, unknown>
    try { b = raw === '' ? {} : JSON.parse(raw) } catch { return bad('bad json') }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('body must be an object')
    if (!id) {
      if (typeof b.repo !== 'string' || !isAbsolute(b.repo)) return bad('repo must be an absolute path')
      if (typeof b.prompt !== 'string') return bad('prompt is required')
      const workspaceId = typeof b.workspaceId === 'string' ? b.workspaceId : null
      return { status: 201, body: await svc.start({ repo: b.repo, prompt: b.prompt, count: Number(b.count), workspaceId }) }
    }
    if (verb === 'pick') {
      if (typeof b.candidateId !== 'string') return bad('candidateId is required')
      return { status: 200, body: await svc.pick(id, b.candidateId) }
    }
    if (verb === 'merge') return { status: 200, body: await svc.merge(id) }
    if (verb === 'cleanup') {
      const r = await svc.cleanup(id, b.confirm === true)
      return r.needsConfirm ? { status: 409, body: { error: 'needs_confirm', remove: r.remove } } : { status: 200, body: r }
    }
    return null
  } catch (e) {
    if (e instanceof BakeoffError) return { status: STATUS[e.code], body: { error: e.code, message: e.message } }
    if (e instanceof WorktreeError) return { status: WT_STATUS[e.code] ?? 400, body: { error: e.code, message: e.message } }
    throw e // unexpected: api.ts logs it and answers 500
  }
}
