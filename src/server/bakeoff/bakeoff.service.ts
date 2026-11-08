// Bake-off (F6, PLAN/04-buku-ide.md #94/#114): one prompt fanned out to 2-4 headless Claude Code agents,
// each in its own worktree, then a comparison card per candidate and a human-picked winner.
//
// Copied from Cursor Best-of-N (cursor.com/docs/configuration/worktrees): "Each run gets its own
// worktree", the tool "compares runs only" (no auto-scoring, the human chooses), and it "does not merge
// changes back into your main checkout for you" (applying the winner is a separate, explicit step).
// From Claude Code worktrees (code.claude.com/docs/en/common-workflows): a worktree is a separate
// checkout on its own branch created from an existing commit, so every candidate starts at one base SHA.
// webterm differences: the card carries server evidence (F4-c verifier: diff stat, tests) and cost, and
// losers are only removed after an explicit confirm (Cursor's page leaves that undefined).
//
// Headless (agentSpawn `mode: 'headless'`), not canvas terminal nodes: a fan-out needs a reliable "done"
// (process exit) and the final JSON result (cost, error) for every candidate, which the DAG already
// gets this way; an interactive TUI has neither without idle heuristics.
import { randomBytes } from 'node:crypto'
import type { ExecOutcome } from '../central/agents/execRunner'
import { bakeoffGate, beginCostRun, endCostRun } from '../cost/costOracle'
import { dagWorkerArgv } from '../dag/dag.ports'
import { pickModel } from '../models/modelPick'
import { git } from '../gitScm'
import { createInboxItem, resolveItem } from '../inbox/inboxItemStore'
import type { LedgerContext } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { evidenceVerified } from '../orchestrator/orchestratorModel'
import { isSensitivePath } from '../repoHygiene'
import type { AgentSpawnRequest, AgentSpawnResult } from '../spawn/agentSpawn'
import type { CompletionVerdict } from '../verifier/verifier.judge'
import type { VerifyDirOptions } from '../verifier/verifier.checks'
import { createWorkspaceWorktree, removeWorkspaceWorktree, type WorktreeDeps } from '../workspaceWorktree'
import { outcomeCostMicros, outcomeError, outcomeOk, outcomeText, toCandidateVerdict } from './bakeoff.outcome'
import { createBakeoffStore, type BakeoffView, type CandidateView } from './bakeoff.store'

const log = createLogger('bakeoff')
export const BAKEOFF_MIN = 2
export const BAKEOFF_MAX = 4
export const BAKEOFF_PROMPT_MAX = 32768
export const BAKEOFF_TIMEOUT_MS = 30 * 60_000
/** Edit tools plus the build/test runners; `Bash(...)` stays a scoped pre-approval (dagWorkerArgv). */
export const BAKEOFF_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(npm *)', 'Bash(bun *)']
export const BAKEOFF_SOURCE = 'bakeoff'

export type BakeoffErrorCode = 'bad_request' | 'not_found' | 'wrong_state' | 'base_moved' | 'dirty_repo' | 'merge_conflict' | 'git_failed' | 'cost_cap'
export class BakeoffError extends Error {
  constructor(readonly code: BakeoffErrorCode, message: string, options?: { cause?: unknown }) { super(message, options) }
}

export interface BakeoffPorts {
  ctx: LedgerContext
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>
  verify(cwd: string, opts: VerifyDirOptions): Promise<CompletionVerdict>
  worktree?: WorktreeDeps
  timeoutMs?: number
}

export interface StartInput { repo: string; prompt: string; count: number; workspaceId?: string | null }

async function gitOut(cwd: string, args: string[], what: string): Promise<string> {
  const r = await git(cwd, args)
  if (r.code !== 0) throw new BakeoffError('git_failed', `${what} in ${cwd} failed: ${r.stderr.trim().slice(0, 300)}`)
  return r.stdout.trim()
}

const usd = (micros: number | null): string => (micros === null ? 'cost unknown' : `$${(micros / 1e6).toFixed(2)}`)
const secs = (ms: number | null): string => (ms === null ? '' : `${Math.round(ms / 1000)}s`)

/** One inbox line per candidate, so the card reads on Telegram too. */
export function candidateLine(c: CandidateView): string {
  const what = c.status === 'failed' ? `failed: ${c.error ?? c.verdict?.summary ?? 'unknown'}` : c.verdict?.summary ?? 'no verdict'
  return `#${c.idx} ${what} · ${usd(c.costMicros)} · ${secs(c.durationMs)}`
}

/** Commits a candidate's work on its branch; secret-looking paths are never staged (Rule 7). */
async function commitCandidate(path: string, idx: number): Promise<void> {
  await gitOut(path, ['add', '-A'], 'staging the candidate')
  const secret = (await gitOut(path, ['diff', '--cached', '--name-only', '-z'], 'reading staged files')).split('\0').filter((p) => p && isSensitivePath(p))
  if (secret.length > 0) await gitOut(path, ['reset', '-q', '--', ...secret], 'unstaging secret-looking files')
  if ((await git(path, ['diff', '--cached', '--quiet'])).code === 0) return
  await gitOut(path, ['commit', '-m', `chore(bakeoff): candidate #${idx} result`], 'committing the winner')
}

export function createBakeoffService(ports: BakeoffPorts) {
  const store = createBakeoffStore(ports.ctx)
  const runs = new Map<string, Promise<void>>()

  function view(id: string): BakeoffView {
    const b = store.get(id)
    if (!b) throw new BakeoffError('not_found', `bake-off ${id} not found`)
    return b
  }

  /** Every candidate settled: the bake-off becomes `ready` and the "pick a winner" card opens. */
  function maybeReady(id: string): void {
    const b = view(id)
    if (b.status !== 'running' || b.candidates.some((c) => c.status === 'running')) return
    const item = createInboxItem(ports.ctx, {
      kind: 'review', source: BAKEOFF_SOURCE, workspaceId: b.workspaceId, dedupeKey: `bakeoff:${id}`,
      title: `Bake-off ready: pick a winner of ${b.candidates.length}`,
      body: `${b.prompt.slice(0, 200)}\n${b.candidates.map(candidateLine).join('\n')}\nOpen Bake-off from ⌘K to compare and pick.`,
    })
    store.setStatus(id, 'ready', { inboxItemId: item.id })
  }

  async function settle(c: { id: string; bakeoffId: string; idx: number; path: string; startedAt: number; costRunId: string }, o: ExecOutcome, baseSha: string): Promise<void> {
    let verdict: CompletionVerdict | null = null
    let verifyError: string | null = null
    try {
      // Committed first, so every candidate is a plain branch: the verifier's base diff gives real stats
      // and the winner merges as is.
      await commitCandidate(c.path, c.idx)
      verdict = await ports.verify(c.path, { taskId: c.id, baseRef: baseSha, claim: outcomeText(o) })
    } catch (err) {
      verifyError = `verifier error: ${err instanceof Error ? err.message : String(err)}`
    }
    const ok = outcomeOk(o) && verifyError === null
    const costMicros = outcomeCostMicros(o.lastEvent)
    try {
      endCostRun(ports.ctx.db, c.costRunId, { costMicros }, ports.ctx.now)
    } catch (err) {
      log.warn('bakeoff.cost_end_failed', `Cannot close cost run for candidate ${c.id}`, { cause: err instanceof Error ? err.message : String(err) })
    }
    store.finishCandidate(c.id, {
      status: ok ? 'done' : 'failed', exitCode: o.exitCode, error: outcomeError(o) ?? verifyError,
      costMicros, durationMs: ports.ctx.now() - c.startedAt,
      verified: verdict ? evidenceVerified(verdict.evidence) : false, verdict: verdict ? toCandidateVerdict(verdict) : null,
    })
    maybeReady(c.bakeoffId)
  }

  async function start(input: StartInput): Promise<BakeoffView> {
    const prompt = input.prompt.trim()
    if (!prompt || prompt.length > BAKEOFF_PROMPT_MAX) throw new BakeoffError('bad_request', `prompt must be 1-${BAKEOFF_PROMPT_MAX} characters`)
    if (!Number.isInteger(input.count) || input.count < BAKEOFF_MIN || input.count > BAKEOFF_MAX) throw new BakeoffError('bad_request', `count must be ${BAKEOFF_MIN}-${BAKEOFF_MAX}`)
    // Before any worktree exists: a refused bake-off leaves nothing to clean up.
    const gate = bakeoffGate(ports.ctx.db, { count: input.count, workspaceId: input.workspaceId ?? null }, ports.ctx.now)
    if (!gate.allowed) throw new BakeoffError('cost_cap', gate.reason ?? 'the daily cost cap refuses this bake-off')
    const baseBranch = await gitOut(input.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 'reading the current branch')
    const baseSha = await gitOut(input.repo, ['rev-parse', 'HEAD'], 'reading HEAD')
    const id = randomBytes(8).toString('hex')
    const created: Array<{ path: string; branch: string; primary: string }> = []
    try {
      for (let i = 1; i <= input.count; i++) {
        created.push(await createWorkspaceWorktree({ repo: input.repo, title: `bakeoff-${id.slice(0, 6)}-${i}`, base: baseSha }, ports.worktree))
      }
    } catch (err) {
      // Fresh, untouched checkouts: removing them loses nothing, and a half-made bake-off is worse.
      for (const w of created) await removeWorkspaceWorktree({ path: w.path, confirm: true, deleteBranch: true }, ports.worktree).catch((e: unknown) => log.warn('bakeoff.rollback_failed', `Cannot roll back worktree ${w.path}`, { cause: String(e) }))
      throw err
    }
    store.insert({ id, workspaceId: input.workspaceId ?? null, repo: created[0]!.primary, baseBranch, baseSha, prompt })
    // One pick for every candidate: a bake-off compares runs of the same prompt, so they must share a model
    // or the comparison measures the model, not the run. (Candidates carry no model of their own today.)
    const pick = pickModel(ports.ctx.db, { kind: 'bakeoff', workspaceId: input.workspaceId ?? null, runRef: `bakeoff:${id}` }, ports.ctx.now)
    const settled: Promise<void>[] = []
    for (const [i, w] of created.entries()) {
      const candId = `${id}-${i + 1}`
      const nodeId = `bakeoff-${candId}`
      store.insertCandidate({ id: candId, bakeoffId: id, idx: i + 1, nodeId, path: w.path, branch: w.branch })
      const startedAt = ports.ctx.now()
      let res: AgentSpawnResult
      try {
        res = await ports.spawn({
          mode: 'headless', door: 'orchestrator', parent: 'human-ui', cwd: w.path, nodeId, prompt, title: `Bake-off #${i + 1}`,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          headless: { argv: dagWorkerArgv(prompt, BAKEOFF_TOOLS, pick), timeoutMs: ports.timeoutMs ?? BAKEOFF_TIMEOUT_MS },
        })
      } catch (err) {
        res = { ok: false, code: 'spawn_invalid', message: err instanceof Error ? err.message : String(err) }
      }
      if (!res.ok || !res.handle) {
        const message = res.ok ? 'no process handle' : res.message
        store.finishCandidate(candId, { status: 'failed', exitCode: null, error: `spawn: ${message}`, costMicros: null, durationMs: 0, verified: false, verdict: null })
        continue
      }
      const costRunId = beginCostRun(ports.ctx.db, { kind: 'bakeoff', ref: id, label: `Bake-off #${i + 1}`, workspaceId: input.workspaceId ?? null, nodeId, tier: pick.tier, model: pick.model }, () => startedAt)
      settled.push(res.handle.done.then((o) => settle({ id: candId, bakeoffId: id, idx: i + 1, path: w.path, startedAt, costRunId }, o, baseSha)))
    }
    const all = Promise.all(settled).then(() => maybeReady(id))
      .catch((err: unknown) => log.error('bakeoff.settle_failed', `Settling bake-off ${id} failed`, { cause: err instanceof Error ? err.message : String(err) }))
      .finally(() => runs.delete(id))
    runs.set(id, all)
    return view(id)
  }

  async function pick(id: string, candidateId: string): Promise<BakeoffView> {
    const b = view(id)
    if (b.status !== 'ready' && b.status !== 'picked') throw new BakeoffError('wrong_state', `bake-off ${id} is ${b.status}; pick needs every candidate finished`)
    const c = b.candidates.find((x) => x.id === candidateId)
    if (!c || c.status === 'removed') throw new BakeoffError('not_found', `candidate ${candidateId} not found in bake-off ${id}`)
    store.setStatus(id, 'picked', { winnerId: c.id })
    if (b.inboxItemId) resolveItem(ports.ctx, b.inboxItemId, { status: 'done', resolution: `winner #${c.idx}`, by: 'human-ui' })
    return view(id)
  }

  /** Merges the winner's branch into the workspace checkout, only on the base branch with a clean tree. */
  async function merge(id: string): Promise<BakeoffView> {
    const b = view(id)
    const winner = b.candidates.find((c) => c.id === b.winnerId)
    if (b.status !== 'picked' || !winner) throw new BakeoffError('wrong_state', `bake-off ${id} is ${b.status}; pick a winner first`)
    const branch = await gitOut(b.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 'reading the workspace branch')
    if (branch !== b.baseBranch) throw new BakeoffError('base_moved', `the workspace is on ${branch}, the bake-off started from ${b.baseBranch}; switch back to merge`)
    if (await gitOut(b.repo, ['status', '--porcelain', '--untracked-files=no'], 'reading workspace status')) {
      throw new BakeoffError('dirty_repo', 'the workspace has uncommitted changes; commit or stash them before merging')
    }
    await commitCandidate(winner.path, winner.idx) // edits made in the worktree by hand after the run
    const r = await git(b.repo, ['merge', '--no-ff', '-m', `Merge bake-off winner #${winner.idx} (${winner.branch})`, winner.branch])
    if (r.code !== 0) {
      await git(b.repo, ['merge', '--abort'])
      throw new BakeoffError('merge_conflict', `merging ${winner.branch} into ${branch} conflicts; the merge was aborted`)
    }
    store.setStatus(id, 'merged')
    return view(id)
  }

  /** What `cleanup` removes: losers, plus the winner once merged. An unmerged winner is kept. */
  function cleanupTargets(b: BakeoffView): CandidateView[] {
    return b.candidates.filter((c) => c.status !== 'removed' && (c.id !== b.winnerId || b.status === 'merged'))
  }

  /** Without `confirm` nothing is touched: the answer lists what would go. */
  async function cleanup(id: string, confirm: boolean): Promise<{ needsConfirm: true; remove: CandidateView[] } | { needsConfirm: false; removed: string[]; bakeoff: BakeoffView }> {
    const b = view(id)
    if (b.status !== 'picked' && b.status !== 'merged') throw new BakeoffError('wrong_state', `bake-off ${id} is ${b.status}; pick a winner before cleaning up`)
    const targets = cleanupTargets(b)
    if (!confirm) return { needsConfirm: true, remove: targets }
    const removed: string[] = []
    for (const c of targets) {
      const r = await removeWorkspaceWorktree({ path: c.path, confirm: true, deleteBranch: true }, ports.worktree)
      // The human confirmed discarding this candidate, so an unmerged loser branch goes too (`-D`).
      if (r.removed && !r.branchDeleted && r.branch && c.id !== b.winnerId) await gitOut(b.repo, ['branch', '-D', r.branch], `deleting ${r.branch}`)
      store.markRemoved(c.id)
      removed.push(c.id)
    }
    if (b.status === 'merged') store.setStatus(id, 'cleaned')
    return { needsConfirm: false, removed, bakeoff: view(id) }
  }

  /** After a restart: candidates whose agent died with the old process are failed, finished runs become ready. */
  function recover(): void {
    const ids = new Set<string>()
    for (const o of store.orphans()) {
      store.finishCandidate(o.id, { status: 'failed', exitCode: null, error: 'server restarted before the agent finished', costMicros: null, durationMs: ports.ctx.now() - o.startedAt, verified: false, verdict: null })
      ids.add(o.bakeoffId)
    }
    for (const id of ids) maybeReady(id)
  }

  return { start, pick, merge, cleanup, recover, get: view, list: store.list, cleanupTargets,
    /** Test hook: resolves once every candidate of `id` settled. */
    settled: (id: string): Promise<void> => runs.get(id) ?? Promise.resolve() }
}

export type BakeoffService = ReturnType<typeof createBakeoffService>
