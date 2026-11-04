// HTTP binding of workspaceWorktree.ts, same `{status, body} | null` contract as gitScm.route.ts.
//
//   GET  /api/workspace-worktree/status?path=                        branch + dirty + unpushed
//   POST /api/workspace-worktree/create {repo, title, branch?, base?, runSetup?}
//   POST /api/workspace-worktree/remove {path, confirm?, deleteBranch?}  409 needs_confirm when dirty
//
// POSTs create/remove checkouts and run a repo's setup script, so they are human-UI only
// (`uiOnlyDenial`, as the SCM POSTs): an agent credential gets 403.
import type { IncomingMessage } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from './approvalAuth'
import { isValidNodeToken } from './hooksTokens'
import { WorktreeError } from './orchestrator/worktree'
import { createWorkspaceWorktree, removeWorkspaceWorktree, worktreeStatus, type WorktreeDeps } from './workspaceWorktree'
import { WORKTREE_CREATE_PATH, WORKTREE_PREFIX, WORKTREE_REMOVE_PATH, WORKTREE_STATUS_PATH } from './workspaceWorktree.types'

type Result = { status: number; body: unknown } | null

const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })
const STATUS: Partial<Record<WorktreeError['code'], number>> = { branch_in_use: 409, not_found: 404, git_failed: 500 }

export interface WorktreeRouteDeps extends WorktreeDeps { isNodeToken?: (token: string) => boolean }

export async function workspaceWorktreeRoute(req: IncomingMessage, url: URL, body: () => Promise<string>, deps: WorktreeRouteDeps = {}): Promise<Result> {
  const path = url.pathname
  if (path !== WORKTREE_PREFIX && !path.startsWith(`${WORKTREE_PREFIX}/`)) return null
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && path === WORKTREE_STATUS_PATH) {
      const p = url.searchParams.get('path')
      if (!p) return bad('path is required')
      return { status: 200, body: await worktreeStatus(p, deps) }
    }
    if (method !== 'POST' || (path !== WORKTREE_CREATE_PATH && path !== WORKTREE_REMOVE_PATH)) return null
    const denial = uiOnlyDenial(req, url, deps.isNodeToken ?? isValidNodeToken)
    if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_manage_worktrees' : denial, message: 'Worktree workspaces are created and removed by the human at the webterm UI only.' } }
    let b: Record<string, unknown>
    try { b = JSON.parse(await body()) } catch { return bad('bad json') }
    if (!b || typeof b !== 'object') return bad('body must be an object')
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined)
    if (path === WORKTREE_CREATE_PATH) {
      if (!str('repo') || !str('title')?.trim()) return bad('repo and title are required')
      const created = await createWorkspaceWorktree(
        { repo: str('repo')!, title: str('title')!, branch: str('branch'), base: str('base'), runSetup: b.runSetup !== false },
        deps
      )
      return { status: 201, body: created }
    }
    if (!str('path')) return bad('path is required')
    const r = await removeWorkspaceWorktree({ path: str('path')!, confirm: b.confirm === true, deleteBranch: b.deleteBranch === true }, deps)
    return r.removed ? { status: 200, body: r } : { status: 409, body: { error: 'needs_confirm', ...r } }
  } catch (e) {
    if (!(e instanceof WorktreeError)) throw e // unexpected: api.ts logs it and answers 500
    return { status: STATUS[e.code] ?? 400, body: { error: e.code, message: e.message } }
  }
}
