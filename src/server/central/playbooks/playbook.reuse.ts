// Worker reuse inside a playbook run: decides ONCE (before task.create) whether a finished agent takes the task, and
// carries the hand-over out in place of `agent.spawn` (+ the browser step). Any failure falls back to the normal spawn.
import { appendEvent } from '../../ledger/ledgerEvent'
import { createLogger } from '../../logs'
import { markReused, pickReusableAgent, pickReusableBrowser, type Rejection, type ReusePorts } from '../agents/agentReuse'
import type { ExecResult, ToolCtx } from '../tools/toolTypes'
import { type Params, type Playbook, type Saved, renderBrief } from './playbook.defs'

const log = createLogger('central')
/** Rejections kept per recorded decision, so the event stays small however many agents were scanned. */
const REJECTED_KEPT = 10
/** Opens the follow-up so the agent does not mix the new task with its earlier ones. */
export const NEW_TASK_PREFIX = 'new task: ignore earlier tasks except your tool state; report with a RESULT line'

export type ExecFn = (ctx: ToolCtx, name: string, args: Record<string, unknown>) => Promise<ExecResult>
export interface ReuseRun { id: string; projectId: string; params: Params; saved: Saved }
export type ReusePortsSource = ReusePorts | (() => Promise<ReusePorts>)

const record = (ctx: ToolCtx, run: ReuseRun, phase: string, extra: Record<string, unknown>): void => {
  appendEvent({ db: ctx.db, now: ctx.now }, { kind: 'central.agent', actor: 'central', projectId: run.projectId, payload: { phase, runId: run.id, ...extra } })
}
const kept = (rejected: Rejection[]): Rejection[] => rejected.slice(0, REJECTED_KEPT)

/** Saved under `reuse` before the first step: the chosen agent/browser (or none) and why the others were refused. */
export async function decideReuse(ctx: ToolCtx, pb: Playbook, run: ReuseRun, source: ReusePortsSource): Promise<Record<string, unknown>> {
  const ports = typeof source === 'function' ? await source() : source
  const spawn = pb.steps.find((s) => s.tool === 'agent.spawn')?.args(run.params, {}, run.id) ?? {}
  const d = pickReusableAgent(ctx.db, ports, { projectId: run.projectId, role: String(spawn.role), kind: String(spawn.kind), complexity: pb.complexity, playbookId: pb.id }, ctx.now)
  const browser = d.pick && pb.steps.some((s) => s.tool === 'browser_open') ? pickReusableBrowser(ctx.db, ports, d.pick.nodeId, run.projectId) : null
  record(ctx, run, d.pick ? 'reuse.chosen' : 'reuse.none', { agentId: d.pick?.agentId ?? null, reason: d.pick?.reason ?? null, browserNodeId: browser?.nodeId ?? null, browserMode: browser?.mode ?? null, rejected: kept(d.rejected) })
  return { ...(d.pick ? { agentId: d.pick.agentId, nodeId: d.pick.nodeId, reason: d.pick.reason } : {}), ...(browser ? { browserNodeId: browser.nodeId, browserMode: browser.mode } : {}), rejected: kept(d.rejected) }
}

/** Hands the new task to the chosen agent as a follow-up. True = handed over (saved `agent`); false = spawn normally. */
export async function reuseInsteadOfSpawn(ctx: ToolCtx, pb: Playbook, run: ReuseRun, exec: ExecFn): Promise<boolean> {
  const reuse = run.saved.reuse
  const agentId = typeof reuse?.agentId === 'string' ? reuse.agentId : null
  const taskId = run.saved.task?.taskId
  if (!reuse || reuse.failed || !agentId || typeof taskId !== 'string') return false
  const browserNodeId = typeof reuse.browserNodeId === 'string' ? reuse.browserNodeId : undefined
  const text = `${NEW_TASK_PREFIX}\n\n${renderBrief(pb.brief(run.params, run.id, browserNodeId))}`
  let failure: string | null = null
  try {
    const r = await exec(ctx, 'agent.prompt', { projectId: run.projectId, agentRef: agentId, text, mode: 'followup', taskId })
    if (!r.ok) failure = r.code ?? 'prompt_failed'
  } catch (err) {
    failure = 'prompt_threw'
    log.warn('central.reuse_prompt_threw', `follow-up to agent ${agentId} threw for run ${run.id}`, { agentId, runId: run.id, error: err instanceof Error ? err.message : String(err) })
  }
  if (failure) {
    run.saved.reuse = { ...reuse, failed: failure }
    record(ctx, run, 'reuse.fallback', { agentId, error: failure })
    return false
  }
  markReused(ctx.db, agentId, ctx.now())
  run.saved.agent = { agentId, state: 'working', nodeId: reuse.nodeId, reused: true }
  return true
}

/** Browser of a reused agent: its cabled one stays, an idle one is re-cabled; false = no reusable browser, open one as usual. */
export async function reuseBrowser(ctx: ToolCtx, run: ReuseRun, source: ReusePortsSource): Promise<boolean> {
  const reuse = run.saved.reuse
  const nodeId = typeof reuse?.browserNodeId === 'string' ? reuse.browserNodeId : null
  if (!run.saved.agent?.reused || !reuse || !nodeId) return false
  if (reuse.browserMode === 'cabled') { run.saved.browser = { nodeId, reused: true }; return true }
  const ports = typeof source === 'function' ? await source() : source
  const linked = ports.link(String(reuse.nodeId), nodeId)
  run.saved.browser = linked ? { nodeId, reused: true, rewired: true } : { error: 'link_refused' }
  record(ctx, run, linked ? 'reuse.browser_rewired' : 'reuse.browser_link_refused', { agentId: reuse.agentId, browserNodeId: nodeId })
  return true
}
