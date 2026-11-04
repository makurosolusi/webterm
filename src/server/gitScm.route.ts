// HTTP binding of the Source Control panel (gitScm.ts + gitScm.report.ts), same `{status, body} | null`
// contract as gitDiff.route.ts (null = not this route).
//
//   GET  /api/git/scm/status?root=                       grouped status, each group capped (R0)
//   GET  /api/git/scm/hunks?root=&path=&area=            hunks of one file (staged|unstaged)
//   GET  /api/git/scm/report?root=                       latest pre-push report, or null
//   POST /api/git/scm/stage    {root, path, hunkId?}     ┐
//   POST /api/git/scm/unstage  {root, path, hunkId?}     │ every POST is human-UI only: `uiOnlyDenial`
//   POST /api/git/scm/message  {root}                    │ (approvalAuth.ts) answers 403 to any agent
//   POST /api/git/scm/commit   {root, message}           │ credential (node token, capability token,
//   POST /api/git/scm/report   {root}                    │ so Central and `webterm` CLI calls too) and
//   POST /api/git/scm/push     {root, acknowledge?}      │ to anything that is not the webterm page
//   POST /api/git/scm/pr       {root}                    ┘
import type { IncomingMessage } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from './approvalAuth'
import { GitDiffError, repoRootOf } from './gitDiff'
import { commit, ScmError, scmHunks, scmStatus, stage, suggestMessage, unstage } from './gitScm'
import { createPr, latestReport, makeReport, push } from './gitScm.report'
import { isValidNodeToken } from './hooksTokens'
import {
  SCM_COMMIT_PATH, SCM_HUNKS_PATH, SCM_MESSAGE_PATH, SCM_PR_PATH, SCM_PREFIX, SCM_PUSH_PATH, SCM_REPORT_PATH,
  SCM_STAGE_PATH, SCM_STATUS_PATH, SCM_UNSTAGE_PATH,
} from './gitScm.types'

type Result = { status: number; body: unknown } | null

const DIFF_STATUS: Record<GitDiffError['code'], number> = {
  not_a_repo: 400, bad_path: 400, not_changed: 404, sensitive: 403, undo_unsupported: 400, stale: 409, conflict: 409, git_failed: 500,
}

const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })

function fail(e: unknown): Result {
  if (e instanceof ScmError) return { status: e.status, body: { error: e.code, message: e.message } }
  if (e instanceof GitDiffError) return { status: DIFF_STATUS[e.code], body: { error: e.code, message: e.message } }
  throw e // unexpected: api.ts's net logs it and answers 500
}

export interface ScmRouteDeps { isNodeToken: (token: string) => boolean }

export async function gitScmRoute(req: IncomingMessage, url: URL, body: () => Promise<string>, deps: ScmRouteDeps = { isNodeToken: isValidNodeToken }): Promise<Result> {
  const path = url.pathname
  if (path !== SCM_PREFIX && !path.startsWith(`${SCM_PREFIX}/`)) return null
  const method = req.method ?? 'GET'
  const q = url.searchParams
  try {
    if (method === 'GET') {
      const rootParam = q.get('root')
      if (!rootParam) return bad('root is required')
      const root = await repoRootOf(rootParam)
      if (path === SCM_STATUS_PATH) return { status: 200, body: await scmStatus(root) }
      if (path === SCM_REPORT_PATH) return { status: 200, body: { report: latestReport(root) } }
      if (path === SCM_HUNKS_PATH) {
        const area = q.get('area')
        if (area !== 'staged' && area !== 'unstaged') return bad("area: 'staged' | 'unstaged'")
        return { status: 200, body: { hunks: await scmHunks(root, q.get('path') ?? '', area) } }
      }
      return null
    }
    if (method !== 'POST') return null
    const denial = uiOnlyDenial(req, url, deps.isNodeToken)
    if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_use_scm' : denial, message: 'Source control actions are for the human at the webterm UI only.' } }
    let b: { root?: unknown; path?: unknown; hunkId?: unknown; message?: unknown; acknowledge?: unknown }
    try { b = JSON.parse(await body()) } catch { return bad('bad json') }
    if (!b || typeof b.root !== 'string' || !b.root) return bad('root is required')
    const hunkId = typeof b.hunkId === 'string' && b.hunkId ? b.hunkId : undefined
    const root = await repoRootOf(b.root)
    switch (path) {
      case SCM_STAGE_PATH: await stage(root, b.path as string, hunkId); return { status: 200, body: { ok: true } }
      case SCM_UNSTAGE_PATH: await unstage(root, b.path as string, hunkId); return { status: 200, body: { ok: true } }
      case SCM_MESSAGE_PATH: return { status: 200, body: await suggestMessage(root) }
      case SCM_COMMIT_PATH: {
        if (typeof b.message !== 'string') return bad('message is required')
        const r = await commit(root, b.message)
        return r.ok ? { status: 200, body: r } : { status: 409, body: r }
      }
      case SCM_REPORT_PATH: return { status: 200, body: { report: await makeReport(root) } }
      case SCM_PUSH_PATH: return { status: 200, body: await push(root, b.acknowledge === true) }
      case SCM_PR_PATH: return { status: 200, body: await createPr(root) }
      default: return null
    }
  } catch (e) {
    return fail(e)
  }
}
