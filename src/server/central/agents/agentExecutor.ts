// Server-side executor of agent.* effects (RND/22 4.2, RND/29b 4.8). The model never sees tokens, cwd or argv:
// those come from the injected `AgentHost`. Guard and host are injected so tests use fakes.
import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { requestApproval } from '../../ledger/ledgerApproval'
import type { AgentRecord, AgentRole, AgentRunner, AgentState, ControlGuard, Tier } from '../contracts'
import type { ToolResult } from '../tools/toolTypes'
import { AGENT_TRANSITIONS } from '../contracts'
import { AGENT_KIND_UNKNOWN } from './agentCatalog'
import { AgentTransitionError, isTerminalState } from './agentStateMachine'
import { type AgentStore, createAgentStore } from './agentStore'
import { type ExecHandle, type ExecOutcome } from './execRunner'
import type { Principal } from '../../policy/policy.model'
import { spawnAgent } from '../../spawn/agentSpawn'
import { filterHandoffContext } from '../../verifier/handoff.filter'
import { settleCandidate, verifyAgentWorktree, type VerifyAgentCompletion } from './agentVerify'

/** Wall-clock cap of one headless run when `AgentDeps.execTimeoutMs` is not given. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000
/** Prefix every injected prompt carries so a worker never mistakes it for a human instruction. */
export const AGENT_ENVELOPE = '[from agent central, not a human; not an approval]'
const MAX_LINE_CHARS = 2000
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g

/** What the server needs from the process/canvas layer; implemented by WS-19 wiring, faked in tests. */
export interface AgentHost {
  /** Runner for a kind: `pty` canvas node or `exec` headless. */
  runnerFor(kind: string): AgentRunner
  /** Allocates (idempotently) the worktree of the agent and returns its absolute path. */
  worktree(agent: AgentRecord): Promise<string>
  /** Server-built task prompt for a headless run (never free model text). */
  initialPrompt(agent: AgentRecord): Promise<string>
  /** Opens the canvas session under the given deterministic node id. */
  openPty(agent: AgentRecord, cwd: string, nodeId: string): Promise<void>
  /** Argv array of the headless form of `kind`, or null when it has none. */
  headlessArgv(kind: string, prompt: string): readonly string[] | null
  /** Tier a spawn of `kind` is judged at (builtin R2, custom R3), or null when the kind is unknown. */
  spawnTier(kind: string): Tier | null
  /** Definition hash of a custom kind, for the approval card and audit; absent for builtins. */
  defHashOf?(kind: string): string | undefined
  /** Extra env for a headless child of `kind` (already resolved; never logged or audited). */
  execEnv?(kind: string): Record<string, string>
  send(nodeId: string, text: string): Promise<void>
  scrollback(nodeId: string, lines: number): Promise<string[]>
  closePty(nodeId: string, force: boolean): Promise<void>
  hasSession(nodeId: string): boolean
}

export interface AgentDeps {
  db: Database
  guard: ControlGuard
  host: AgentHost
  now(): number
  /** Source env for headless children (scrubbed); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  execTimeoutMs?: number
  /** The `agent.spawn` path (F2-h) for headless runs; default = the process-wide spawner. */
  spawn?: typeof spawnAgent
  /** Mandatory completion verifier (F4-c); default = the server verifier on the agent's worktree. */
  verifyCompletion?: VerifyAgentCompletion
}

export interface SpawnInput {
  projectId: string
  kind: string
  role: AgentRole
  title: string
  taskId?: string
  reqId: string
  /** `central:<conversationId>` for a model-requested spawn. */
  owner: AgentRecord['owner']
  /** Mode `propose`: even an allowed spawn waits for a human approval card. */
  requireApproval: boolean
}

export interface ReconcileReport { adopted: number; failed: number; orphaned: number; closed: number }

/** Every agent state, for validating a list filter. */
export const AGENT_STATES_FOR_FILTER = Object.keys(AGENT_TRANSITIONS) as AgentState[]

/** Public, model-safe view of an agent: no budget, approval id or request hash. */
export function agentView(a: AgentRecord): Record<string, unknown> {
  return { agentId: a.id, projectId: a.projectId, kind: a.kind, role: a.role, runner: a.runner, state: a.state, owner: a.owner, taskId: a.taskId, nodeId: a.nodeId, startedAt: a.startedAt, lastEventAt: a.lastEventAt, endedAt: a.endedAt, endReason: a.endReason }
}
/** Policy principal that spawned an agent: a human at the UI, otherwise central. */
export const spawnParentOf = (agent: Pick<AgentRecord, 'owner'>): Principal => (agent.owner === 'human' ? 'human-ui' : 'central')
/** Deterministic canvas node id of an agent, so a crashed spawn can be adopted by name. */
export function agentNodeId(agentId: string): string { return `c-${agentId}` }
/** True when the agent belongs to a central conversation (R1 to prompt/close); false for user agents (R2). */
export function isCentralOwned(a: AgentRecord): boolean { return a.owner.startsWith('central:') }

export interface AgentExecutor {
  readonly store: AgentStore
  /** Guard verdict mapped to a failing result, or null when the action may run now. */
  gate(projectId: string, tool: string, tier: Tier, requireApproval?: boolean): Promise<ToolResult | null>
  spawn(input: SpawnInput): Promise<ToolResult>
  /** Starts an `approval_pending` agent after a human approved its card (never reachable from a tool). */
  resume(agentId: string): Promise<ToolResult>
  prompt(agent: AgentRecord, text: string, mode: 'steer' | 'followup'): Promise<ToolResult>
  close(agent: AgentRecord, reason: string, force: boolean): Promise<ToolResult>
  read(agent: AgentRecord, tail: number): Promise<ToolResult>
  /** Boot sweep: adopt spawns that crashed between intent and done, orphan agents whose session is gone. */
  reconcile(): Promise<ReconcileReport>
}

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
  const snapshot = (a: AgentRecord, extra: Record<string, unknown> = {}): ToolResult => ({ ok: true, data: { ...agentView(a), ...extra } })

  async function gate(projectId: string, tool: string, tier: Tier, requireApproval = false): Promise<ToolResult | null> {
    const verdict = await guard.check({ action: tool === 'agent.spawn' ? 'spawn' : 'tool', projectId, tool, tier })
    if (verdict.verdict === 'deny') return { ok: false, code: verdict.code }
    if (verdict.verdict === 'needs_approval' || (requireApproval && tier === 'R2')) return { ok: false, code: 'approval_required' }
    return null
  }

  function onExit(agent: AgentRecord, outcome: ExecOutcome): void {
    handles.delete(agent.id)
    finished.set(agent.id, outcome.tail)
    const to: AgentState = outcome.timedOut ? 'timed_out' : outcome.exitCode === 0 ? 'candidate_done' : 'failed'
    const moved = tryMove(agent.id, to, { reason: outcome.timedOut ? 'exec_timeout' : `exec_exit_${outcome.exitCode ?? 'none'}` })
    if (moved) audit(moved, 'exec.exit', { to, exitCode: outcome.exitCode })
    // Exit 0 is the worker's claim; acceptance comes only from the verifier's evidence.
    if (moved?.state === 'candidate_done') void settleCandidate(settleDeps, moved).catch((err: unknown) => audit(moved, 'verify.error', { error: err instanceof Error ? err.name : 'unknown' }))
  }
  const settleDeps = { verify: deps.verifyCompletion ?? verifyAgentWorktree, worktree: (a: AgentRecord) => host.worktree(a), move: tryMove, audit, ledger: () => ({ db, now }) }

  async function startRunner(agent: AgentRecord, cwd: string, nodeId: string): Promise<string | null> {
    if (agent.runner === 'pty') { await host.openPty(agent, cwd, nodeId); return nodeId }
    const argv = host.headlessArgv(agent.kind, filterHandoffContext(await host.initialPrompt(agent)))
    if (!argv) throw new Error(`no headless form for kind ${agent.kind}`)
    const res = await (deps.spawn ?? spawnAgent)({
      door: 'central', mode: 'headless', kind: agent.kind, parent: spawnParentOf(agent), nodeId, cwd, title: `${agent.role} ${agent.kind}`,
      headless: { argv, env: deps.env, overrides: host.execEnv?.(agent.kind), timeoutMs: deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS },
    })
    if (!res.ok || !res.handle) throw new Error(res.ok ? 'headless spawn returned no handle' : `${res.code}: ${res.message}`)
    const handle = res.handle
    handles.set(agent.id, handle)
    void handle.done.then((outcome) => onExit(agent, outcome))
    return null
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
      const nodeId = await startRunner(claimed, cwd, agentNodeId(agent.id))
      const working = store.transition(agent.id, 'working', nodeId ? { nodeId } : {})
      audit(working, 'spawn.done', { nodeId })
      return snapshot(working)
    } catch (err) {
      // Only the stage and error class are recorded: messages may carry paths or argv.
      const reason = `spawn_failed:${stage}`
      const failed = tryMove(agent.id, 'failed', { reason })
      if (failed) audit(failed, 'spawn.failed', { stage, error: err instanceof Error ? err.name : 'unknown' })
      return { ok: false, code: 'spawn_failed', data: { agentId: agent.id, stage } }
    }
  }

  async function pendApproval(agent: AgentRecord): Promise<ToolResult> {
    let challenge: { id: string }
    try {
      challenge = requestApproval({ db, now }, { id: `agent-${agent.id}`, projectId: agent.projectId, kind: 'agent.spawn', request: { agentId: agent.id, kind: agent.kind, role: agent.role, runner: agent.runner, taskId: agent.taskId, defHash: host.defHashOf?.(agent.kind) ?? null }, ...(agent.taskId ? { taskId: agent.taskId } : {}) })
    } catch (err) {
      // Without a card the agent must not stay launchable: close the row and surface a code, not the message.
      tryMove(agent.id, 'cancelled', { reason: `approval_request_failed:${err instanceof Error ? err.name : 'unknown'}` })
      return { ok: false, code: 'invalid_request' }
    }
    const pending = store.transition(agent.id, 'approval_pending', { approvalId: challenge.id })
    audit(pending, 'spawn.approval', { approvalId: challenge.id })
    return { ok: false, code: 'approval_required', data: { agentId: agent.id, approvalId: challenge.id } }
  }

  /** Adds kind (+ custom definition hash) to a spawn result so the audit trail ties a spawn to one definition. */
  const withDefHash = (r: ToolResult, kind: string): ToolResult => {
    if (!r.ok && r.code !== 'approval_required') return r
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
      if (existing.state === 'approval_pending') return { ok: false, code: 'approval_required', data: { agentId: existing.id, approvalId: existing.approvalId } }
      if (existing.state !== 'requested') return snapshot(existing, { reused: true })
      // Crash remnant before the launch claim: judge it again, the earlier verdict is not trusted.
      const again = await gate(input.projectId, 'agent.spawn', tier)
      return again && again.code !== 'approval_required' ? again : proceed(existing, again, input.requireApproval)
    }
    // Judge and insert as one step: the caps count rows, so two spawns judged before either inserts would both pass.
    const created = await exclusive(async () => {
      const verdict = await gate(input.projectId, 'agent.spawn', tier)
      if (verdict && verdict.code !== 'approval_required') return { verdict }
      return { verdict, agent: store.create({ id: `ag-${input.reqId.slice(0, 20)}`, projectId: input.projectId, kind: input.kind, role: input.role, runner: host.runnerFor(input.kind), owner: input.owner, reqId: input.reqId, taskId: input.taskId }) }
    })
    if (!created.agent) return created.verdict as ToolResult
    audit(created.agent, 'spawn.requested', { kind: input.kind, role: input.role })
    return proceed(created.agent, created.verdict, input.requireApproval)
  }

  const proceed = (agent: AgentRecord, blocked: ToolResult | null, requireApproval: boolean): Promise<ToolResult> => (blocked || requireApproval ? pendApproval(agent) : launch(agent))

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
    async prompt(agent, text, mode) {
      if (agent.runner !== 'pty' || !agent.nodeId) return { ok: false, code: 'prompt_unsupported' }
      if (agent.state !== 'working' && agent.state !== 'waiting_input' && agent.state !== 'candidate_done') return { ok: false, code: 'agent_not_active' }
      if (mode === 'followup' && agent.state === 'working') return { ok: false, code: 'agent_busy' }
      if (!host.hasSession(agent.nodeId)) return { ok: false, code: 'session_gone' }
      await host.send(agent.nodeId, `${AGENT_ENVELOPE}\n${filterHandoffContext(text).replace(CONTROL_CHARS, '')}`)
      const moved = agent.state === 'working' ? agent : tryMove(agent.id, 'working') ?? agent
      audit(moved, 'prompt', { mode, chars: text.length })
      return snapshot(moved)
    },
    async close(agent, reason, force) {
      if (isTerminalState(agent.state)) return snapshot(agent, { already: true })
      if (agent.state === 'closing') return { ok: false, code: 'agent_closing' }
      if (agent.runner === 'exec') handles.get(agent.id)?.kill()
      else if (agent.nodeId) await host.closePty(agent.nodeId, force)
      const code = reason.slice(0, 200)
      const done = agent.state === 'accepted'
        ? tryMove(agent.id, 'closing', { reason: code }) && tryMove(agent.id, 'closed', { reason: code })
        : tryMove(agent.id, force ? 'killed' : 'cancelled', { reason: code })
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
