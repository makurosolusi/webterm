// Server-side executor of agent.* effects (RND/22 4.2, RND/29b 4.8). The model never sees tokens, cwd or argv:
// those come from the injected `AgentHost`. Guard and host are injected so tests use fakes.
import { appendEvent } from '../../ledger/ledgerEvent'
import type { AgentRecord, AgentState, Tier } from '../contracts'
import type { ToolResult } from '../tools/toolTypes'
import { AGENT_KIND_UNKNOWN } from './agentCatalog'
import { AgentTransitionError, isTerminalState } from './agentStateMachine'
import { createAgentStore, type AgentStore } from './agentStore'
import { type ExecHandle, type ExecOutcome } from './execRunner'
import { spawnAgent } from '../../spawn/agentSpawn'
import type { ModelPick } from '../../models/modelLadder'
import { ladderJson, pickForAgent } from './agentLadder'
import { filterHandoffContext } from '../../verifier/handoff.filter'
import { settleCandidate, verifyAgentWorktree } from './agentVerify'
import { settleExecTask } from '../work/workLifecycle'
import { createLogger } from '../../logs'
import { slotRefusal } from '../guard/controlGuard'
import { AGENT_ENVELOPE, DEFAULT_EXEC_TIMEOUT_MS, agentNodeId, agentView, spawnParentOf, withLadderModel } from './agentExecutor.model'
import { createApprovalFlow, isTaintedOwner } from './agentExecutor.approval'
import type { AgentDeps, AgentExecutor, ReconcileReport, SpawnInput } from './agentExecutor.types'

// Re-exported: the executor's public surface is imported from here by 20+ modules.
export { AGENT_ENVELOPE, AGENT_STATES_FOR_FILTER, DEFAULT_EXEC_TIMEOUT_MS, agentNodeId, agentView, isCentralOwned, spawnParentOf, withLadderModel } from './agentExecutor.model'
export type { AgentDeps, AgentExecutor, AgentHost, ReconcileReport, SpawnInput } from './agentExecutor.types'

const log = createLogger('central.agents')
const MAX_LINE_CHARS = 2000
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g

/** Builds the executor over a store on `deps.db`. */
export function createAgentExecutor(deps: AgentDeps): AgentExecutor {
  const { host, guard, db, now } = deps
  const store = createAgentStore(db, now)
  const handles = new Map<string, ExecHandle>()
  const finished = new Map<string, string>()
  const inflight = new Map<string, Promise<ToolResult>>()
  const audit = (a: AgentRecord, phase: string, extra: Record<string, unknown> = {}): void => {
    appendEvent({ db, now }, { kind: 'central.agent', actor: 'central', projectId: a.projectId, payload: { phase, agentId: a.id, ...extra } })
  }
  /** Moves along a legal edge; a lost race (agent already moved/ended) yields null, any other failure propagates. */
  const tryMove = (id: string, to: AgentState, patch: Parameters<AgentStore['transition']>[2] = {}): AgentRecord | null => {
    try { return store.transition(id, to, patch) } catch (err) {
      if (err instanceof AgentTransitionError && err.code !== 'agent_not_found') return null
      throw err
    }
  }
  const skip = (projectId: string): boolean => guard.skipsApprovals?.(projectId) === true
  const snapshot = (a: AgentRecord, extra: Record<string, unknown> = {}): ToolResult => ({ ok: true, data: { ...agentView(a), ...extra } })

  async function gate(projectId: string, tool: string, tier: Tier, requireApproval = false): Promise<ToolResult | null> {
    const verdict = await guard.check({ action: tool === 'agent.spawn' ? 'spawn' : 'tool', projectId, tool, tier })
    if (verdict.verdict === 'deny') return { ok: false, code: verdict.code }
    if (verdict.verdict === 'needs_approval' || (requireApproval && tier === 'R2' && !skip(projectId))) return { ok: false, code: 'approval_required' }
    return null
  }

  function onExit(agent: AgentRecord, outcome: ExecOutcome): void {
    handles.delete(agent.id)
    finished.set(agent.id, outcome.tail)
    const to: AgentState = outcome.timedOut ? 'timed_out' : outcome.exitCode === 0 ? 'candidate_done' : 'failed'
    const reason = outcome.timedOut ? 'exec_timeout' : `exec_exit_${outcome.exitCode ?? 'none'}`
    const moved = tryMove(agent.id, to, { reason })
    if (moved) audit(moved, 'exec.exit', { to, exitCode: outcome.exitCode })
    // A headless run sends no hooks, so its exit is its report: the board task moves now (reported or failed), which wakes
    // Central, instead of stalling on the liveness rules. Same tick as the agent move, before the end observer's sweep.
    if (moved) {
      try { settleExecTask(db, now, agent.nodeId ?? agentNodeId(agent.id), { ok: to === 'candidate_done', reason, tail: outcome.tail }) } catch (err) {
        audit(moved, 'exec.task_error', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' })
      }
    }
    // Exit 0 is the worker's claim; acceptance comes only from the verifier's evidence.
    if (moved?.state === 'candidate_done') void settleCandidate(settleDeps, moved).catch((err: unknown) => audit(moved, 'verify.error', { error: err instanceof Error ? err.name : 'unknown' }))
  }
  const settleDeps = { verify: deps.verifyCompletion ?? verifyAgentWorktree, worktree: (a: AgentRecord) => host.worktree(a), move: tryMove, audit, ledger: () => ({ db, now }) }

  async function startRunner(agent: AgentRecord, cwd: string, nodeId: string): Promise<{ nodeId: string | null; pick: ModelPick }> {
    // One ladder decision for both runners (stored on the row, so a resume keeps it).
    const pick = pickForAgent(db, agent, now)
    if (agent.runner === 'pty') { await host.openPty(agent, cwd, nodeId, pick); return { nodeId, pick } }
    const own = host.headlessArgv(agent.kind, filterHandoffContext(await host.initialPrompt(agent)))
    if (!own) throw new Error(`no headless form for kind ${agent.kind}`)
    const argv = withLadderModel(own, pick)
    const res = await (deps.spawn ?? spawnAgent)({
      door: 'central', mode: 'headless', kind: agent.kind, parent: spawnParentOf(agent), nodeId, cwd, title: `${agent.role} ${agent.kind}`,
      headless: { argv, pick, env: deps.env, overrides: host.execEnv?.(agent.kind), timeoutMs: deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS },
    })
    if (!res.ok || !res.handle) throw new Error(res.ok ? 'headless spawn returned no handle' : `${res.code}: ${res.message}`)
    const handle = res.handle
    handles.set(agent.id, handle)
    // onExit writes the ledger (a vanished row or a failed write throws); unheard, that rejection ends the server.
    void handle.done.then((outcome) => onExit(agent, outcome)).catch((err: unknown) =>
      log.error('agent.exit_settle_failed', `exit of agent ${agent.id} could not be settled`, { agentId: agent.id, projectId: agent.projectId, error: err instanceof Error ? err.message : String(err) }))
    return { nodeId: null, pick }
  }

  /** requested|approval_pending -> provisioning (the atomic claim) -> starting -> working, with intent/done audit. */
  async function launch(agent: AgentRecord): Promise<ToolResult> {
    const claimed = tryMove(agent.id, 'provisioning')
    if (!claimed) return snapshot(store.get(agent.id) ?? agent, { reused: true })
    audit(claimed, 'spawn.intent', { reqId: agent.reqId })
    // Counted at intent, not done: a crash between the two must not give the budget back.
    await guard.recordUsage({ projectId: agent.projectId, turns: 0, tokens: 0, costMicros: 0, spawns: 1, wallMs: 0 })
    let stage = 'worktree'
    try {
      const cwd = await host.worktree(claimed)
      store.transition(agent.id, 'starting')
      stage = 'runner'
      const started = await startRunner(claimed, cwd, agentNodeId(agent.id))
      const working = store.transition(agent.id, 'working', started.nodeId ? { nodeId: started.nodeId } : {})
      const used = { tier: started.pick.tier, model: started.pick.model, effort: started.pick.effort }
      audit(working, 'spawn.done', { nodeId: started.nodeId, ...used })
      return snapshot(working, used)
    } catch (err) {
      // Only the stage and error class are recorded: messages may carry paths or argv.
      const reason = `spawn_failed:${stage}`
      const failed = tryMove(agent.id, 'failed', { reason })
      if (failed) audit(failed, 'spawn.failed', { stage, error: err instanceof Error ? err.name : 'unknown' })
      return { ok: false, code: 'spawn_failed', data: { agentId: agent.id, stage } }
    }
  }

  const { pendApproval, endPending, settlePending, refused } = createApprovalFlow({ db, now, host, store, tryMove, skip, snapshot, audit, gate, launch })

  /** Adds kind (+ custom definition hash) to a spawn result so the audit trail ties a spawn to one definition. */
  const withDefHash = (r: ToolResult, kind: string): ToolResult => {
    if (!r.ok && r.code !== 'approval_required' && r.code !== 'approval_rejected' && r.code !== 'approval_expired') return r
    const defHash = host.defHashOf?.(kind)
    return { ...r, data: { ...r.data, kind, ...(defHash ? { defHash } : {}) } }
  }

  let spawnChain: Promise<unknown> = Promise.resolve()
  /** Runs `fn` after every earlier exclusive step settled (the chain itself never rejects). */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = spawnChain.then(fn)
    spawnChain = run.catch(() => undefined)
    return run
  }

  async function doSpawn(input: SpawnInput): Promise<ToolResult> {
    // Unknown kind is refused before the guard, the store or the audit trail see it.
    const tier = host.spawnTier(input.kind)
    if (!tier) return { ok: false, code: AGENT_KIND_UNKNOWN }
    const existing = store.getByReqId(input.reqId)
    if (existing) {
      if (existing.projectId !== input.projectId || existing.kind !== input.kind || existing.role !== input.role || existing.taskId !== (input.taskId ?? null)) return { ok: false, code: 'request_conflict' }
      if (existing.state === 'approval_pending') return settlePending(existing, tier)
      if (existing.state === 'cancelled' && existing.endReason === 'approval_rejected') return refused(existing, 'rejected')
      if (existing.state === 'cancelled' && existing.endReason === 'approval_expired') return refused(existing, 'expired')
      if (existing.state !== 'requested') return snapshot(existing, { reused: true })
      // Crash remnant before the launch claim: judge it again, the earlier verdict is not trusted.
      const again = await gate(input.projectId, 'agent.spawn', tier)
      return again && again.code !== 'approval_required' ? again : proceed(existing, again, input.requireApproval)
    }
    // Judge and insert as one step: the caps count rows, so two spawns judged before either inserts would both pass.
    const created = await exclusive(async () => {
      const verdict = await gate(input.projectId, 'agent.spawn', tier)
      if (verdict && verdict.code !== 'approval_required') return { verdict }
      return { verdict, agent: store.create({ id: `ag-${input.reqId.slice(0, 20)}`, projectId: input.projectId, kind: input.kind, role: input.role, runner: host.runnerFor(input.kind), owner: input.owner, reqId: input.reqId, taskId: input.taskId, budgetJson: ladderJson(input.complexity) }) }
    })
    if (!created.agent) return created.verdict as ToolResult
    audit(created.agent, 'spawn.requested', { kind: input.kind, role: input.role })
    return proceed(created.agent, created.verdict, input.requireApproval)
  }

  const proceed = (agent: AgentRecord, blocked: ToolResult | null, requireApproval: boolean): Promise<ToolResult> => (blocked || ((requireApproval || isTaintedOwner(agent.owner, now())) && !skip(agent.projectId)) ? pendApproval(agent) : launch(agent))

  const live = (a: AgentRecord): boolean => (a.runner === 'exec' ? handles.has(a.id) : !!a.nodeId && host.hasSession(a.nodeId))

  return {
    store,
    gate,
    spawn(input) {
      const running = inflight.get(input.reqId)
      if (running) return running
      const p = doSpawn(input).then((r) => withDefHash(r, input.kind)).finally(() => inflight.delete(input.reqId))
      inflight.set(input.reqId, p)
      return p
    },
    async resume(agentId) {
      const agent = store.get(agentId)
      return agent?.state === 'approval_pending' ? launch(agent) : { ok: false, code: 'not_pending' }
    },
    reject(agentId) {
      const agent = store.get(agentId)
      return agent?.state === 'approval_pending' ? endPending(agent, 'rejected') : { ok: false, code: 'not_pending' }
    },
    expire(agentId) {
      const agent = store.get(agentId)
      return agent?.state === 'approval_pending' ? endPending(agent, 'expired') : { ok: false, code: 'not_pending' }
    },
    async renew(agentId) {
      const agent = store.get(agentId)
      return agent?.state === 'approval_pending' ? pendApproval(agent) : { ok: false, code: 'not_pending' }
    },
    async prompt(agent, text, mode) {
      if (agent.runner !== 'pty' || !agent.nodeId) return { ok: false, code: 'prompt_unsupported' }
      if (agent.state !== 'working' && agent.state !== 'waiting_input' && agent.state !== 'candidate_done') return { ok: false, code: 'agent_not_active' }
      if (mode === 'followup' && agent.state === 'working') return { ok: false, code: 'agent_busy' }
      if (!host.hasSession(agent.nodeId)) return { ok: false, code: 'session_gone' }
      // A finished agent holds no slot: waking it claims one (the single activation point; a user typing into the node bypasses it, the work is already running).
      if (agent.state === 'candidate_done') { const full = slotRefusal(db, agent.projectId); if (full) return { ok: false, code: full } }
      const sent = await host.send(agent.nodeId, `${AGENT_ENVELOPE}\n${filterHandoffContext(text).replace(CONTROL_CHARS, '')}`)
      if (!sent.ok) return { ok: false, code: sent.reason, data: { hint: sent.message } }
      const moved = agent.state === 'working' ? agent : tryMove(agent.id, 'working') ?? agent
      audit(moved, 'prompt', { mode, chars: text.length })
      return snapshot(moved)
    },
    async close(agent, reason, force) {
      if (isTerminalState(agent.state)) return snapshot(agent, { already: true })
      if (agent.state === 'closing') return { ok: false, code: 'agent_closing' }
      const code = reason.slice(0, 200)
      // Moved before the PTY goes: closing it publishes pty.exit synchronously, which would win as session_exited.
      const done = agent.state === 'accepted'
        ? tryMove(agent.id, 'closing', { reason: code }) && tryMove(agent.id, 'closed', { reason: code })
        : tryMove(agent.id, force ? 'killed' : 'cancelled', { reason: code })
      if (agent.runner === 'exec') handles.get(agent.id)?.kill()
      else if (agent.nodeId) await host.closePty(agent.nodeId, force)
      audit(agent, 'close', { force, to: done?.state ?? null })
      return done ? snapshot(done) : { ok: false, code: 'conflict' }
    },
    async read(agent, tail) {
      const raw = agent.runner === 'exec' ? (handles.get(agent.id)?.tail() ?? finished.get(agent.id) ?? '').split('\n') : agent.nodeId ? await host.scrollback(agent.nodeId, tail) : []
      return { ok: true, data: { agentId: agent.id, lines: raw.slice(-tail).map((l) => l.slice(0, MAX_LINE_CHARS)) } }
    },
    async reconcile() {
      const report: ReconcileReport = { adopted: 0, failed: 0, orphaned: 0, closed: 0 }
      for (const agent of store.listActive()) {
        if (agent.state === 'requested' || agent.state === 'approval_pending') continue
        const nodeId = agentNodeId(agent.id)
        if (agent.runner === 'pty' && host.hasSession(nodeId)) host.ensureNode?.(agent, nodeId)
        if (agent.state === 'provisioning' || agent.state === 'starting') {
          const adopt = agent.runner === 'pty' && host.hasSession(nodeId)
          if (adopt && (agent.state === 'starting' || tryMove(agent.id, 'starting'))) {
            const working = tryMove(agent.id, 'working', { nodeId })
            if (working) { audit(working, 'spawn.done', { nodeId, adopted: true }); report.adopted++ }
          } else if (tryMove(agent.id, 'failed', { reason: 'spawn_interrupted' })) report.failed++
        } else if (!live(agent)) {
          const to: AgentState = agent.state === 'closing' ? 'closed' : 'orphaned'
          if (tryMove(agent.id, to, { reason: 'session_gone_at_boot' })) report[to === 'closed' ? 'closed' : 'orphaned']++
        }
      }
      return report
    },
  }
}
