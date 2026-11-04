// HTTP binding of prreview.service.ts, `{status, body} | null` like bakeoff.api.ts.
//
//   GET  /api/prreview?repo=/abs            jobs (running/finished) and open drafts of one repo
//   POST /api/prreview {repo, pr, workspaceId?}   start a review: 202 with the job
//   POST /api/prreview/<itemId>/post        "Post review": approves the draft gate, then posts it
//
// Both POSTs are human-UI only (`uiOnlyDenial`): an agent credential gets 403, so no agent can start
// a paid review or, above all, publish to GitHub on the user's behalf.
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { actorForRequest } from '../approvalHumanShared'
import type { AppendEventInput } from '../events/eventModel'
import { actOnItem } from '../inbox/inboxActions'
import type { LedgerContext } from '../ledger/ledgerCore'
import { WorktreeError } from '../orchestrator/worktree'
import { GhError } from './prreview.gh'
import { PrReviewError, type PrReviewService } from './prreview.service'

export const PRREVIEW_PATH = '/api/prreview'
export const PRREVIEW_BODY_MAX_BYTES = 16 * 1024

type Result = { status: number; body: unknown } | null
const STATUS: Record<PrReviewError['code'], number> = { bad_request: 400, not_found: 404, busy: 409, not_approved: 409, invalid_draft: 400, git_failed: 500 }
const GH_STATUS: Record<GhError['code'], number> = { gh_missing: 400, gh_unauthed: 401, gh_failed: 502 }
const bad = (message: string): Result => ({ status: 400, body: { error: 'bad_request', message } })

export interface PrReviewApiDeps {
  service: PrReviewService
  ctx: LedgerContext
  isNodeToken(token: string): boolean
  record(e: AppendEventInput): void
}

export async function handlePrReviewApi(deps: PrReviewApiDeps, req: IncomingMessage, url: URL, body: () => Promise<string>): Promise<Result> {
  const path = url.pathname
  if (path !== PRREVIEW_PATH && !path.startsWith(`${PRREVIEW_PATH}/`)) return null
  const [itemId, verb, ...rest] = path.slice(PRREVIEW_PATH.length + 1).split('/').filter(Boolean)
  if (rest.length > 0) return null
  const method = req.method ?? 'GET'
  const svc = deps.service
  try {
    if (method === 'GET') {
      if (itemId) return null
      const repo = url.searchParams.get('repo') ?? ''
      if (!isAbsolute(repo)) return bad('repo must be an absolute path')
      await svc.reconcile()
      return { status: 200, body: { jobs: svc.jobs(repo), drafts: svc.drafts(repo) } }
    }
    if (method !== 'POST') return null
    const denial = uiOnlyDenial(req, url, deps.isNodeToken)
    if (denial) return { status: 403, body: { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_review_prs' : denial, message: 'PR reviews are started and posted by the human at the webterm UI only.' } }
    if (!itemId) {
      let b: Record<string, unknown>
      try { b = JSON.parse((await body()) || '{}') } catch { return bad('bad json') }
      if (!b || typeof b !== 'object' || typeof b.repo !== 'string' || !isAbsolute(b.repo)) return bad('repo must be an absolute path')
      const workspaceId = typeof b.workspaceId === 'string' && b.workspaceId ? b.workspaceId : null
      return { status: 202, body: svc.start({ repo: b.repo, pr: Number(b.pr), workspaceId }) }
    }
    if (verb !== 'post') return null
    // The click IS the approval: decided like the Inbox button (same ledger approval and event), then posted.
    const acted = await actOnItem({ ctx: deps.ctx, actor: actorForRequest(req, url), record: deps.record,
      outbox: () => Promise.reject(new Error('posting a PR review never sends agent mail')) }, itemId, { type: 'approve' })
    if (acted.status !== 200 && acted.body.error !== 'not_open') return { status: acted.status, body: acted.body }
    return { status: 200, body: await svc.post(itemId) }
  } catch (e) {
    if (e instanceof PrReviewError) return { status: STATUS[e.code], body: { error: e.code, message: e.message } }
    if (e instanceof GhError) return { status: GH_STATUS[e.code], body: { error: e.code, message: e.message } }
    if (e instanceof WorktreeError) return { status: 400, body: { error: e.code, message: e.message } }
    throw e // unexpected: api.ts logs it and answers 500
  }
}
