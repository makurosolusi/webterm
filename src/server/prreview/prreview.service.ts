// PR review bot (F6): fetch a PR through `gh`, review its head in a fresh worktree with a headless,
// read-only Claude Code run (agent.spawn), and land the findings in the Inbox as a DRAFT. Nothing
// reaches GitHub until the human approves that draft; then ONE review with inline comments is posted
// through `gh api`. Reference and prompt: prreview.model.ts.
//
// The draft is an Inbox gate (ledger approval, R3 "cannot be rewound"): single use (consumeApproval),
// never batch-approved (inboxActions R3 guard), editable (the human may drop or reword findings), and
// it expires like every gate (max 24 h; review the PR again after that). No table of our own: the
// gate's args are the draft, its resolution records the posted review URL.
import { createHash, randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import type { ExecOutcome } from '../central/agents/execRunner'
import { dagWorkerArgv } from '../dag/dag.ports'
import { git } from '../gitScm'
import { approvedArgsFor, createGate, createInboxItem, getInboxItem, resolveItem } from '../inbox/inboxItemStore'
import { approvalDigest, consumeApproval, getApproval } from '../ledger/ledgerApproval'
import { allRows, getRow, type LedgerContext } from '../ledger/ledgerCore'
import { projectRepository } from '../ledger/ledgerEntity'
import { createLogger } from '../logs'
import type { Principal } from '../policy/policy.model'
import type { AgentSpawnRequest, AgentSpawnResult, SpawnDoor } from '../spawn/agentSpawn'
import { createWorkspaceWorktree, removeWorkspaceWorktree, type WorktreeDeps } from '../workspaceWorktree'
import type { Gh } from './prreview.gh'
import { draftBody, parseDraft, parseFindings, reviewPayload, reviewPrompt, slugOfPrUrl, type PrDraft } from './prreview.model'

const log = createLogger('prreview')
export const PRREVIEW_SOURCE = 'prreview'
/** Read-only: the reviewer may look, never change or run anything. */
export const PRREVIEW_TOOLS = ['Read', 'Glob', 'Grep']
export const PRREVIEW_TIMEOUT_MS = 15 * 60_000
/** Gate lifetime: the ledger's maximum. */
export const DRAFT_TTL_MS = 24 * 3_600_000
/** A poll reviews at most this many new PR heads (each is a paid Claude run). */
export const POLL_MAX_NEW = 3
const POLL_LIST_LIMIT = 30
const JOBS_KEPT = 50

export type PrReviewErrorCode = 'bad_request' | 'not_found' | 'busy' | 'not_approved' | 'invalid_draft' | 'git_failed'
export class PrReviewError extends Error {
  constructor(readonly code: PrReviewErrorCode, message: string) { super(message) }
}

export interface PrReviewPorts {
  ctx: LedgerContext
  gh: Gh
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>
  worktree?: WorktreeDeps
  timeoutMs?: number
}

export interface ReviewInput { repo: string; pr: number; workspaceId?: string | null; parent?: Principal; door?: SpawnDoor }

export interface PrReviewJob {
  id: string
  repo: string
  pr: number
  status: 'running' | 'drafted' | 'clean' | 'failed'
  error: string | null
  itemId: string | null
  findings: number
  startedAt: number
}

export interface DraftView { itemId: string; title: string; pr: number; url: string; findings: number; inline: number; expiresAt: number | null }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function gitOut(cwd: string, args: string[], what: string): Promise<string> {
  const r = await git(cwd, args, undefined, 120_000)
  if (r.code !== 0) throw new PrReviewError('git_failed', `${what} failed: ${r.stderr.trim().slice(0, 300)}`)
  return r.stdout.trim()
}

/** The ledger project a gate hangs on: the workspace's (as dag.plan), else one per repo path. */
function projectFor(ctx: LedgerContext, repo: string, workspaceId: string | null): string {
  const id = workspaceId ?? `repo-${createHash('sha256').update(repo).digest('hex').slice(0, 16)}`
  const row = getRow(ctx.db, 'SELECT id FROM project WHERE id = ? OR workspace_id = ?', id, id)
  if (row) return String(row['id'])
  return projectRepository(ctx).createProject({ id, workspaceId: id, name: basename(repo), path: repo }).id
}

const outcomeText = (o: ExecOutcome): string => (typeof o.lastEvent?.['result'] === 'string' ? (o.lastEvent['result'] as string) : o.tail)
function outcomeError(o: ExecOutcome): string | null {
  if (o.exitCode === 0 && !o.timedOut && o.lastEvent?.['is_error'] !== true) return null
  if (o.error) return `reviewer could not start: ${o.error}`
  if (o.timedOut) return 'reviewer timed out'
  if (o.lastEvent?.['is_error'] === true) return `reviewer reported an error (${String(o.lastEvent['subtype'] ?? 'error')})`
  return `reviewer exited ${o.exitCode ?? 'by signal'}`
}

export function createPrReviewService(ports: PrReviewPorts) {
  const { ctx } = ports
  const jobs = new Map<string, PrReviewJob>()
  const runs = new Map<string, Promise<void>>()
  const posting = new Map<string, Promise<{ url: string }>>()

  const isRunning = (repo: string, pr: number): boolean => [...jobs.values()].some((j) => j.status === 'running' && j.repo === repo && j.pr === pr)
  /** This PR head already has a draft (gate args) or a "no findings" notice (dedupe key), open or closed. */
  const reviewed = (key: string): boolean =>
    !!getRow(ctx.db, `SELECT 1 AS x FROM inbox_item i LEFT JOIN approval a ON a.id = i.approval_id
      WHERE i.source = ? AND (i.dedupe_key = ? OR json_extract(a.request_json, '$.args.key') = ?)`, PRREVIEW_SOURCE, key, key)

  async function review(job: PrReviewJob, input: ReviewInput): Promise<void> {
    const info = await ports.gh.prView(input.repo, input.pr)
    const slug = slugOfPrUrl(info.url)
    if (!slug) throw new PrReviewError('bad_request', `cannot read owner/repo from ${info.url}`)
    const diff = await ports.gh.prDiff(input.repo, input.pr)
    // GitHub keeps every PR head at refs/pull/<n>/head, forks included.
    await gitOut(input.repo, ['fetch', '--no-tags', 'origin', `refs/pull/${input.pr}/head`], `fetching PR #${input.pr}`)
    await gitOut(input.repo, ['cat-file', '-e', `${info.headRefOid}^{commit}`], `finding head ${info.headRefOid.slice(0, 7)}`)
    const wt = await createWorkspaceWorktree({ repo: input.repo, title: `prreview-${input.pr}-${info.headRefOid.slice(0, 7)}`, base: info.headRefOid, runSetup: false }, ports.worktree)
    try {
      const prompt = reviewPrompt({ slug, pr: input.pr, title: info.title, baseRef: info.baseRefName }, diff)
      const res = await ports.spawn({
        mode: 'headless', door: input.door ?? 'canvas', parent: input.parent ?? 'human-ui', cwd: wt.path, prompt, title: `Review PR #${input.pr}`,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        headless: { argv: dagWorkerArgv(prompt, PRREVIEW_TOOLS), timeoutMs: ports.timeoutMs ?? PRREVIEW_TIMEOUT_MS },
      })
      if (!res.ok || !res.handle) throw new Error(`spawn: ${res.ok ? 'no process handle' : res.message}`)
      const outcome = await res.handle.done
      const failed = outcomeError(outcome)
      if (failed) throw new Error(failed)
      const parsed = parseFindings(outcomeText(outcome), diff)
      if (!parsed) throw new Error('the reviewer answered without a findings JSON array')
      const draft: PrDraft = { key: `${info.url}@${info.headRefOid}`, repo: input.repo, slug, pr: input.pr, url: info.url, title: info.title, commitId: info.headRefOid, ...parsed }
      job.findings = draft.findings.length
      if (draft.findings.length === 0) {
        // Nothing to post: a notice, not a gate. The key still marks this head as reviewed for polls.
        const item = createInboxItem(ctx, { kind: 'notify', source: PRREVIEW_SOURCE, workspaceId: input.workspaceId ?? null, title: `PR #${input.pr} review: no findings`, body: draftBody(draft), dedupeKey: draft.key })
        Object.assign(job, { status: 'clean', itemId: item.id })
        return
      }
      const inline = draft.findings.filter((f) => f.inline).length
      const item = createGate(ctx, {
        projectId: projectFor(ctx, input.repo, input.workspaceId ?? null), source: PRREVIEW_SOURCE, workspaceId: input.workspaceId ?? null,
        title: `Post review to ${slug}#${input.pr}: ${draft.findings.length} finding${draft.findings.length === 1 ? '' : 's'}`,
        body: draftBody(draft), args: draft, editable: true, ttlMs: DRAFT_TTL_MS,
        impact: { what: `Posts one review with ${inline} inline comment${inline === 1 ? '' : 's'} to ${slug}#${input.pr} on GitHub`, tier: 'R3', rewindable: false },
      })
      Object.assign(job, { status: 'drafted', itemId: item.id })
    } finally {
      // A review checkout holds nothing of the user's: always removed, branch too.
      const r = await removeWorkspaceWorktree({ path: wt.path, confirm: true, deleteBranch: true }, ports.worktree).catch((e: unknown) => { log.warn('prreview.cleanup_failed', `Cannot remove review worktree ${wt.path}`, { cause: errText(e) }); return null })
      if (r?.removed && !r.branchDeleted && r.branch) await git(wt.primary, ['branch', '-D', r.branch])
    }
  }

  function begin(input: ReviewInput): PrReviewJob {
    const job: PrReviewJob = { id: randomBytes(6).toString('hex'), repo: input.repo, pr: input.pr, status: 'running', error: null, itemId: null, findings: 0, startedAt: ctx.now() }
    jobs.set(job.id, job)
    for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - JOBS_KEPT))) jobs.delete(old)
    const done = review(job, input)
      .catch((e: unknown) => {
        Object.assign(job, { status: 'failed', error: errText(e) })
        createInboxItem(ctx, { kind: 'notify', source: PRREVIEW_SOURCE, workspaceId: input.workspaceId ?? null, title: `PR #${input.pr} review failed`, body: errText(e) })
      })
      .finally(() => runs.delete(job.id))
    runs.set(job.id, done)
    return job
  }

  /** Manual "Review PR #n": answers at once, the run continues in the background. */
  function start(input: ReviewInput): PrReviewJob {
    if (!input.repo.startsWith('/')) throw new PrReviewError('bad_request', 'repo must be an absolute path')
    if (!Number.isInteger(input.pr) || input.pr < 1) throw new PrReviewError('bad_request', 'pr must be a pull request number')
    if (isRunning(input.repo, input.pr)) throw new PrReviewError('busy', `PR #${input.pr} is already being reviewed`)
    return begin(input)
  }

  /** Routine poll: reviews open PRs whose head has no draft yet, at most POLL_MAX_NEW per call; waits for them. */
  async function poll(input: Omit<ReviewInput, 'pr'>): Promise<{ reviewed: number[]; skipped: number }> {
    const open = await ports.gh.prList(input.repo, POLL_LIST_LIMIT)
    const fresh = open.filter((p) => !isRunning(input.repo, p.number) && !reviewed(`${p.url}@${p.headRefOid}`)).slice(0, POLL_MAX_NEW)
    const started = fresh.map((p) => begin({ ...input, pr: p.number }))
    await Promise.all(started.map((j) => runs.get(j.id)))
    return { reviewed: fresh.map((p) => p.number), skipped: open.length - fresh.length }
  }

  async function doPost(itemId: string): Promise<{ url: string }> {
    const item = getInboxItem(ctx.db, itemId)
    if (!item || item.source !== PRREVIEW_SOURCE || !item.approvalId) throw new PrReviewError('not_found', `draft review ${itemId} not found`)
    const approval = getApproval(ctx, item.approvalId)
    if (!approval || approval.status !== 'approved') throw new PrReviewError('not_approved', `draft review ${itemId} is ${approval?.status ?? 'missing'}; approve it in the Inbox first`)
    // Single use: a second click, a retry or the Telegram button can never post the same consent twice.
    if (!consumeApproval(ctx, item.approvalId, { digest: approvalDigest(approval.request) })) throw new PrReviewError('not_approved', `draft review ${itemId} was already posted`)
    const draft = parseDraft(approvedArgsFor(ctx.db, item.approvalId) ?? (approval.request as { args?: unknown }).args)
    if (typeof draft === 'string') {
      resolveItem(ctx, itemId, { status: 'done', resolution: `not posted: ${draft}`, by: 'prreview' })
      throw new PrReviewError('invalid_draft', draft)
    }
    try {
      const res = await ports.gh.postReview(draft.repo, draft.slug, draft.pr, reviewPayload(draft))
      const url = res.html_url ?? draft.url
      resolveItem(ctx, itemId, { status: 'done', resolution: `posted: ${url}`, by: approval.approvedBy ?? 'human' })
      return { url }
    } catch (e) {
      resolveItem(ctx, itemId, { status: 'done', resolution: `post failed: ${errText(e).slice(0, 300)}`, by: 'prreview' })
      createInboxItem(ctx, { kind: 'notify', source: PRREVIEW_SOURCE, workspaceId: item.workspaceId, title: `Posting the review to ${draft.slug}#${draft.pr} failed`, body: errText(e) })
      throw e
    }
  }

  /** Posts an approved draft once; concurrent callers (the Post button and the Inbox decision event) share one run. */
  function post(itemId: string): Promise<{ url: string }> {
    const running = posting.get(itemId)
    if (running) return running
    const p = doPost(itemId).finally(() => posting.delete(itemId))
    posting.set(itemId, p)
    return p
  }

  /** Approved but never consumed (decided while we were down, or on another surface): post them now. */
  async function reconcile(): Promise<void> {
    const ids = allRows(ctx.db, `SELECT i.id FROM inbox_item i JOIN approval a ON a.id = i.approval_id JOIN decision d ON d.id = a.decision_id
      WHERE i.source = ? AND a.status = 'approved' AND d.single_use = 1`, PRREVIEW_SOURCE).map((r) => String(r['id']))
    for (const id of ids) await post(id).catch((e: unknown) => log.warn('prreview.post_failed', `Posting draft review ${id} failed`, { cause: errText(e) }))
  }

  /** Open drafts of one repo for the SCM panel. */
  function drafts(repo: string): DraftView[] {
    return allRows(ctx.db, `SELECT i.id, i.title, a.request_json, a.expires_at FROM inbox_item i JOIN approval a ON a.id = i.approval_id
      WHERE i.source = ? AND i.status = 'open' AND a.status = 'pending' AND json_extract(a.request_json, '$.args.repo') = ? ORDER BY i.created_at DESC LIMIT 50`, PRREVIEW_SOURCE, repo)
      .map((r) => {
        const d = (JSON.parse(String(r['request_json'])) as { args: PrDraft }).args
        return { itemId: String(r['id']), title: String(r['title']), pr: d.pr, url: d.url, findings: d.findings.length, inline: d.findings.filter((f) => f.inline).length, expiresAt: r['expires_at'] === null ? null : Number(r['expires_at']) }
      })
  }

  return {
    start, poll, post, reconcile, drafts,
    jobs: (repo: string): PrReviewJob[] => [...jobs.values()].filter((j) => j.repo === repo).reverse(),
    /** Test hook: resolves once job `id` finished. */
    settled: (id: string): Promise<void> => runs.get(id) ?? Promise.resolve(),
  }
}

export type PrReviewService = ReturnType<typeof createPrReviewService>
