// Runs a playbook step by step through `execTool` and keeps its cursor in `central_playbook_run` (ledger v34).
// A step that stops on an approval card parks the run (`waiting` + the card id); `watchPlaybookApprovals`
// continues it from that step when the card is decided, from any surface (chat card, Telegram, routes).
// A retry of the same call (same conversation, playbook and input) resumes the parked run instead of starting a
// second one. Every start, resume and stop is told to the user through `automaticAction`.
import type { Database } from 'bun:sqlite'
import { approvalDigest, onApprovalChange, type Approval } from '../../ledger/ledgerApproval'
import { execWrite, getRow, newId, type Row } from '../../ledger/ledgerCore'
import { createLogger } from '../../logs'
import { automaticAction, type AutomaticActionDeps } from '../automaticAction'
import { execTool } from '../tools/toolExec'
import { queueCheckinReason } from '../work/workCheckin'
import type { ControlGuard, ExecResult, ToolCtx, ToolInput, ToolResult } from '../tools/toolTypes'
import { type Params, type Playbook, type Saved, playbookById } from './playbook.defs'

const log = createLogger('central')

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'rejected' | 'expired'
/** What Central reports: the run, its board task, the step it is on and where it stands; a finished chain is `started` (the agent works on). */
export type PlaybookReceipt = { runId: string; taskId: string | null; step: string; status: Exclude<RunStatus, 'done'> | 'started' }

/** Tool context of a run's conversation; null while Central is off (the run stays parked). */
export type CtxFor = (conversationId: string) => ToolCtx | null
export type ExecFn = (ctx: ToolCtx, name: string, args: ToolInput) => Promise<ExecResult>
export interface PlaybookDeps {
  /** Step executor; defaults to `execTool` (tests inject a fake). */
  exec?: ExecFn
  /** Senses writer of the automatic-action record; defaults to the process one. */
  record?: AutomaticActionDeps['record']
  /** Bound of the wait for a spawned agent to become active; default AGENT_ACTIVE_WAIT_MS. */
  activeWaitMs?: number
  /** Pause between agent.status polls; defaults to a real timer (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>
}

/** A finished run replays its receipt to an identical call within this window instead of running again. */
export const REPLAY_WINDOW_MS = 60 * 60_000
/**
 * Tools whose handler raises its own approval card (same rule as mcp.central.ts OWN_APPROVAL_TOOLS): the generic
 * guard's `needs_approval` passes so the handler can put the card; a guard deny still denies.
 */
const OWN_CARD_TOOLS: ReadonlySet<string> = new Set(['agent.spawn'])
/** An approved spawn may still be provisioning when the chain continues; a `needsAgent` step waits this long for it. */
export const AGENT_ACTIVE_WAIT_MS = 60_000
export const AGENT_POLL_MS = 2_000
/** States in which agent.prompt is accepted (agentExecutor `prompt`). */
const ACTIVE_STATES: ReadonlySet<string> = new Set(['working', 'waiting_input', 'candidate_done'])
const REFUSED: Record<string, RunStatus> = { approval_rejected: 'rejected', approval_expired: 'expired' }

interface Run { id: string; playbook: string; projectId: string; conversationId: string; params: Params; stepIndex: number; saved: Saved; status: RunStatus; createdAt: number }

const toRun = (r: Row): Run => ({
  id: String(r.id), playbook: String(r.playbook), projectId: String(r.project_id), conversationId: String(r.conversation_id),
  params: JSON.parse(String(r.params_json)) as Params, stepIndex: Number(r.step_index), saved: JSON.parse(String(r.saved_json)) as Saved,
  status: String(r.status) as RunStatus, createdAt: Number(r.created_at),
})

const receiptOf = (pb: Playbook, run: Run): PlaybookReceipt => ({
  runId: run.id, taskId: typeof run.saved.task?.taskId === 'string' ? run.saved.task.taskId : null,
  step: pb.steps[Math.min(run.stepIndex, pb.steps.length - 1)]?.tool ?? '', status: run.status === 'done' ? 'started' : run.status,
})

/** Told with a started run: the agent's own report is pushed, so Central has nothing to poll. */
const startedNote = (pb: Playbook, run: Run): string => {
  const agent = typeof run.saved.agent?.agentId === 'string' ? run.saved.agent.agentId : 'the agent'
  const browser = typeof run.saved.browser?.nodeId === 'string' ? ` with browser node ${run.saved.browser.nodeId} cabled to it` : ''
  return `${pb.label} started: agent ${agent}${browser} has its brief and works on its own. Its RESULT, a question or a failure reaches you by itself as a check-in; do not poll it or set a reminder.`
}

const subjectOf = (pb: Playbook, run: Run): string => run.params[pb.subject] ?? ''

function announce(ctx: ToolCtx, deps: PlaybookDeps, pb: Playbook, run: Run, event: string, text: string): void {
  automaticAction({ db: ctx.db, now: ctx.now, ...(deps.record ? { record: deps.record } : {}) }, {
    name: `playbook_${event}`, actor: 'central', subject: `playbook:${run.id}`, projectId: run.projectId, text,
    noticeKey: `auto:playbook:${run.id}:${event}:${run.stepIndex}`,
  })
}

function save(ctx: ToolCtx, run: Run, approvalId: string | null = null, code: string | null = null): void {
  execWrite(ctx.db, 'UPDATE central_playbook_run SET step_index = ?, saved_json = ?, status = ?, approval_id = ?, code = ?, updated_at = ? WHERE id = ?',
    run.stepIndex, JSON.stringify(run.saved), run.status, approvalId, code, ctx.now(), run.id)
}

/** Only one caller may move a parked run (decision hook vs a retry): the one whose UPDATE changed the row. */
const claim = (ctx: ToolCtx, runId: string): boolean =>
  execWrite(ctx.db, "UPDATE central_playbook_run SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting'", ctx.now(), runId) === 1

/** The step context: own-card tools see the guard's `approval_required` as a pass, so their handler asks. */
function stepCtx(ctx: ToolCtx, tool: string): ToolCtx {
  if (!OWN_CARD_TOOLS.has(tool)) return ctx
  const guard: ControlGuard = {
    check: (req) => { const v = ctx.guard.check(req); return !v.ok && v.code === 'approval_required' ? { ok: true } : v },
    ...(ctx.guard.skipsApprovals ? { skipsApprovals: (id) => ctx.guard.skipsApprovals?.(id) === true } : {}),
  }
  return { ...ctx, guard }
}

const defined = (args: ToolInput): ToolInput => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))

/**
 * Polls agent.status until the saved agent is active, it ended, or the bound passed. Returns null when active,
 * else the failure code and a plain message for the user.
 */
async function waitActive(ctx: ToolCtx, run: Run, exec: ExecFn, deps: PlaybookDeps): Promise<{ code: string; message: string } | null> {
  const agent = run.saved.agent
  const agentId = typeof agent?.agentId === 'string' ? agent.agentId : null
  if (!agentId || ACTIVE_STATES.has(String(agent?.state))) return null
  const bound = deps.activeWaitMs ?? AGENT_ACTIVE_WAIT_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)))
  let state = String(agent?.state ?? 'unknown')
  for (let waited = 0; ; waited += AGENT_POLL_MS) {
    const r = await exec(ctx, 'agent.status', { projectId: run.projectId, agentRef: agentId })
    state = r.ok && typeof r.data?.state === 'string' ? r.data.state : state
    if (ACTIVE_STATES.has(state)) { run.saved.agent = { ...agent, ...r.data }; return null }
    if (r.ok && r.data?.endedAt != null) return { code: 'agent_not_active', message: `agent ${agentId} ended (${state}) before it was ready` }
    if (waited >= bound) return { code: 'agent_not_active', message: `agent ${agentId} did not become active within ${Math.round(bound / 1000)} s (last state ${state})` }
    await sleep(AGENT_POLL_MS)
  }
}

/** Runs the steps from the cursor until the chain ends, parks on a card, or a step fails. */
async function advance(ctx: ToolCtx, pb: Playbook, run: Run, deps: PlaybookDeps): Promise<ToolResult> {
  const exec = deps.exec ?? ((c, name, args) => execTool(c, name, args))
  while (run.stepIndex < pb.steps.length) {
    const step = pb.steps[run.stepIndex] as Playbook['steps'][number]
    const inactive = step.needsAgent ? await waitActive(ctx, run, exec, deps) : null
    if (inactive) {
      run.status = 'failed'
      save(ctx, run, null, inactive.code)
      announce(ctx, deps, pb, run, 'stopped', `Central stopped ${pb.label} (${inactive.message}): ${subjectOf(pb, run)}`)
      return { ok: false, code: inactive.code, data: { ...receiptOf(pb, run), message: inactive.message } }
    }
    const r = await exec(stepCtx(ctx, step.tool), step.tool, defined(step.args(run.params, run.saved, run.id)))
    if (r.ok || (step.optional && r.code !== 'approval_required')) {
      if (step.saveAs) run.saved[step.saveAs] = r.ok ? r.data ?? {} : { error: r.code ?? 'error' }
      run.stepIndex += 1
      save(ctx, run)
      continue
    }
    if (r.code === 'approval_required') {
      const approvalId = typeof r.data?.approvalId === 'string' ? r.data.approvalId : null
      run.status = 'waiting'
      save(ctx, run, approvalId, r.code)
      const hint = approvalId ? 'webterm continues this playbook by itself once the card is decided; do not call it again' : 'retry the same call after the human approves; it continues from this step'
      return { ok: false, code: 'approval_required', data: { ...receiptOf(pb, run), ...(approvalId ? { approvalId, approvalStatus: 'pending' } : {}), hint } }
    }
    run.status = REFUSED[r.code ?? ''] ?? 'failed'
    save(ctx, run, null, r.code ?? 'error')
    announce(ctx, deps, pb, run, 'stopped', `Central stopped ${pb.label} at ${step.tool} (${r.code ?? 'error'}): ${subjectOf(pb, run)}`)
    return { ok: false, code: r.code ?? 'playbook_step_failed', data: { ...receiptOf(pb, run), ...(r.data?.hint ? { hint: r.data.hint } : {}) } }
  }
  run.status = 'done'
  save(ctx, run)
  return { ok: true, data: { ...receiptOf(pb, run), agentId: run.saved.agent?.agentId ?? null, note: startedNote(pb, run) } }
}

/** Starts the playbook, or resumes the parked run of this exact call. */
export async function runPlaybook(ctx: ToolCtx, pb: Playbook, input: ToolInput, projectId: string, deps: PlaybookDeps = {}): Promise<ToolResult> {
  const params: Params = { ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : undefined])), projectId }
  const key = approvalDigest({ conversationId: ctx.conversationId, playbook: pb.id, params })
  const row = getRow(ctx.db, 'SELECT * FROM central_playbook_run WHERE call_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', key)
  const last = row ? toRun(row) : null
  if (last?.status === 'running') return { ok: true, data: receiptOf(pb, last) }
  if (last?.status === 'waiting') {
    if (!claim(ctx, last.id)) return { ok: true, data: receiptOf(pb, last) }
    last.status = 'running'
    return advance(ctx, pb, last, deps)
  }
  if (last?.status === 'done' && last.createdAt > ctx.now() - REPLAY_WINDOW_MS) return { ok: true, data: { ...receiptOf(pb, last), replayed: true } }
  const run: Run = { id: `pb_${newId()}`, playbook: pb.id, projectId, conversationId: ctx.conversationId, params, stepIndex: 0, saved: {}, status: 'running', createdAt: ctx.now() }
  execWrite(ctx.db, `INSERT INTO central_playbook_run (id, playbook, project_id, conversation_id, call_key, params_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`, run.id, pb.id, projectId, ctx.conversationId, key, JSON.stringify(params), run.createdAt, run.createdAt)
  announce(ctx, deps, pb, run, 'started', `Central started ${pb.label}: ${subjectOf(pb, run)}`)
  return advance(ctx, pb, run, deps)
}

/**
 * Nobody waits on a run resumed by a card decision, so its outcome is queued as a check-in: a failure is due at once,
 * a start waits the window (the agent's own report usually lands in the same turn).
 */
function queueResumed(ctx: ToolCtx, pb: Playbook, run: Run, r: ToolResult): void {
  const what = r.ok ? startedNote(pb, run) : `${pb.label} stopped after the approval at ${receiptOf(pb, run).step} (${r.code ?? 'error'}${typeof r.data?.message === 'string' ? `: ${r.data.message}` : ''})`
  queueCheckinReason(ctx.db, {
    kind: 'playbook_result', dedupeKey: `playbook:${run.id}:${run.status}`, projectId: run.projectId, taskId: receiptOf(pb, run).taskId, conversationId: run.conversationId,
    text: `${what}; subject: ${subjectOf(pb, run)}`, now: ctx.now(), ...(r.ok ? {} : { notBefore: ctx.now() }),
  })
}

/** Continues (approved) or ends (rejected, expired) the run parked on `approval`; no-op for other cards. */
export async function resumeOnApproval(db: Database, ctxFor: CtxFor, approval: Approval, deps: PlaybookDeps = {}): Promise<ToolResult | null> {
  if (approval.status === 'pending') return null
  const row = getRow(db, "SELECT * FROM central_playbook_run WHERE approval_id = ? AND status = 'waiting'", approval.id)
  if (!row) return null
  const run = toRun(row)
  const pb = playbookById(run.playbook)
  const ctx = ctxFor(run.conversationId)
  if (!pb || !ctx || !claim(ctx, run.id)) return null
  if (approval.status !== 'approved') {
    run.status = approval.status === 'rejected' ? 'rejected' : 'expired'
    save(ctx, run, approval.id, `approval_${approval.status}`)
    announce(ctx, deps, pb, run, 'stopped', `Central stopped ${pb.label}: the approval was ${approval.status}: ${subjectOf(pb, run)}`)
    const r: ToolResult = { ok: false, code: `approval_${approval.status}`, data: receiptOf(pb, run) }
    queueResumed(ctx, pb, run, r)
    return r
  }
  run.status = 'running'
  announce(ctx, deps, pb, run, 'resumed', `Central resumed ${pb.label} after approval: ${subjectOf(pb, run)}`)
  const r = await advance(ctx, pb, run, deps)
  // A run parked again on a later card is not an outcome yet.
  if ((run.status as RunStatus) !== 'waiting') queueResumed(ctx, pb, run, r)
  return r
}

/** Subscribes the decision hook; `ctxFor` builds the tool context of a run's conversation (null while Central is off). */
export function watchPlaybookApprovals(ctxFor: CtxFor, deps: PlaybookDeps = {}): () => void {
  return onApprovalChange((ledger, approval) => {
    if (approval.status === 'pending') return
    resumeOnApproval(ledger.db, ctxFor, approval, deps).catch((err: unknown) => {
      log.error('central.playbook_resume_failed', 'playbook resume after a decision failed', { approvalId: approval.id, error: err instanceof Error ? err.message : String(err) })
    })
  })
}
