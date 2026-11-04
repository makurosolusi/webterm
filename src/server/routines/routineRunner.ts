// One routine run: trust gate, busy guard, budget cap, cost-oracle gate, shell precheck, then the action (a headless
// Claude agent through `agent.spawn`, or a message into a wired agent's outbox). Every outcome is a
// history row; a finished agent run becomes an inbox review item; start/skip/finish are events.
//
// Order follows Orca `automation-dispatch-request.ts:199-221`: the precheck runs before any agent is
// launched, so "nothing to do" costs zero tokens. Keep-awake (`caffeinate -i`) is held while a run is
// active, like Claude Code Desktop scheduled tasks needing the machine awake.
import type { BeginRunInput, GateResult } from '../cost/costOracle'
import type { AppendEventInput } from '../events/eventModel'
import { createInboxItem } from '../inbox/inboxItemStore'
import type { LedgerContext } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { redactSecrets } from '../redactSecrets'
import type { AgentSpawnRequest, AgentSpawnResult } from '../spawn/agentSpawn'
import { routineTier, untrustedMayFire, type Routine, type RoutineRun, type RunTrigger } from './routineModel'
import { precheckPassed, precheckReason, type PrecheckResult } from './routinePrecheck'
import type { RoutineStore } from './routineStore'

export const ROUTINE_EVENT = { run: 'routine.run', skip: 'routine.skip', finish: 'routine.finish' } as const
export const ROUTINE_SOURCE = 'routines'
const RESULT_MAX = 4000
const log = createLogger('routines')

export interface KeepAwake { acquire(): void; release(): void }

export interface RunnerDeps {
  ctx: LedgerContext
  store: RoutineStore
  spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult>
  enqueue(input: { to: string; body: string; operationId: string; createdBy: string }): Promise<string | null>
  precheck(command: string, cwd: string, timeoutSeconds: number): Promise<PrecheckResult>
  record(input: AppendEventInput): void
  keepAwake: KeepAwake
  /** Working directory for a routine's workspace (null = unknown workspace). */
  cwdOf(workspaceId: string | null): string | null
  /** Cost oracle (costRuntime): gate before a run, a cost window around an agent run. Absent = no gate. */
  cost?: {
    gate(q: { kind: 'routine'; ref: string; workspaceId: string | null }): Promise<GateResult>
    begin(input: BeginRunInput): Promise<string | null>
    end(id: string | null, outcome: { producedDiff?: boolean }): Promise<unknown>
  }
  /** Fingerprint of `cwd` (HEAD + status); a change across the run = the agent produced a diff. null = not git. Never throws. */
  treeState?(cwd: string): Promise<string | null>
}

export interface FireOptions { scheduledFor?: number | null; untrusted?: boolean }
export interface FireResult { run: RoutineRun; done: Promise<void> }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createRoutineRunner(deps: RunnerDeps) {
  const { store } = deps
  const children = new Set<string>()

  const event = (r: Routine, kind: string, payload: Record<string, unknown>): void => deps.record({
    kind, source: ROUTINE_SOURCE, actor: `routine:${r.id}`, subject: `routine:${r.id}`, workspaceId: r.workspaceId,
    trust: 'trusted', payload: { routineId: r.id, ...payload },
  })

  function skip(r: Routine, trigger: RunTrigger, reason: string, scheduledFor: number | null): FireResult {
    const run = store.addRun({ routineId: r.id, trigger, status: 'skipped', reason, scheduledFor })
    event(r, ROUTINE_EVENT.skip, { runId: run.id, trigger, reason })
    return { run, done: Promise.resolve() }
  }

  function settle(r: Routine, runId: string, trigger: RunTrigger, change: Parameters<RoutineStore['finishRun']>[1]): void {
    store.finishRun(runId, change)
    if (change.status === 'skipped') event(r, ROUTINE_EVENT.skip, { runId, trigger, reason: change.reason ?? null })
    else event(r, ROUTINE_EVENT.finish, { runId, trigger, status: change.status, reason: change.reason ?? null, costUsd: change.costUsd ?? null })
  }

  async function execute(r: Routine, runId: string, trigger: RunTrigger, cwd: string): Promise<void> {
    if (deps.cost) {
      const gate = await deps.cost.gate({ kind: 'routine', ref: r.id, workspaceId: r.workspaceId })
      const m = gate.estimate.medianMicros
      if (m !== null) store.finishRun(runId, { status: 'running', estimateUsd: m / 1e6 })
      // costGate reasons: `paused: <why>` (low-ROI pause) or the cap that is used up.
      if (!gate.allowed) return settle(r, runId, trigger, { status: 'skipped', reason: gate.reason?.startsWith('paused:') ? `roi_paused: ${gate.reason.slice(8).trim()}` : `budget: ${gate.reason ?? 'cost cap reached'}` })
    }
    if (r.precheck) {
      const result = await deps.precheck(r.precheck.command, cwd, r.precheck.timeoutSeconds)
      if (!precheckPassed(result)) return settle(r, runId, trigger, { status: 'skipped', reason: precheckReason(result, r.precheck.timeoutSeconds) })
    }
    event(r, ROUTINE_EVENT.run, { runId, trigger, action: r.action.type })
    if (r.action.type === 'outbox') {
      const error = await deps.enqueue({ to: r.action.to, body: r.action.body, operationId: `routine:${runId}`, createdBy: `routine:${r.id}` })
      return settle(r, runId, trigger, error ? { status: 'failed', reason: error } : { status: 'ran', reason: `message queued for ${r.action.to}` })
    }
    const before = deps.treeState ? await deps.treeState(cwd) : null
    const spawned = await deps.spawn({
      mode: 'headless', parent: `routine:${r.id}`, cwd, prompt: r.action.prompt, title: r.name,
      door: 'routine', ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    })
    if (!spawned.ok) return settle(r, runId, trigger, { status: 'failed', reason: `${spawned.code}: ${spawned.message}` })
    children.add(spawned.nodeId)
    store.finishRun(runId, { status: 'running', childId: spawned.childId })
    // Outbox actions open no cost window: their spend lands on the receiving agent, and a message is
    // not a diff, so they never count toward the low-ROI pause.
    let costId: string | null = null
    let producedDiff = false
    try {
      if (deps.cost) costId = await deps.cost.begin({ kind: 'routine', ref: r.id, label: r.name, workspaceId: r.workspaceId, nodeId: spawned.nodeId })
      const outcome = spawned.handle ? await spawned.handle.done : null
      const last = outcome?.lastEvent ?? null
      const costUsd = typeof last?.['total_cost_usd'] === 'number' ? last['total_cost_usd'] : null
      const ok = !!outcome && outcome.exitCode === 0 && last?.['is_error'] !== true
      const reason = !outcome ? 'no process handle' : ok ? null : outcome.timedOut ? 'agent timed out' : outcome.error ? `agent could not start: ${outcome.error}` : `agent exited ${outcome.exitCode ?? 'by signal'}`
      const text = typeof last?.['result'] === 'string' ? last['result'] : outcome?.tail ?? ''
      const item = createInboxItem(deps.ctx, {
        kind: ok ? 'review' : 'notify', source: ROUTINE_SOURCE, workspaceId: r.workspaceId, nodeId: spawned.nodeId,
        title: ok ? `Routine "${r.name}" finished` : `Routine "${r.name}" failed`,
        body: redactSecrets(text).slice(-RESULT_MAX) || reason,
      })
      settle(r, runId, trigger, { status: ok ? 'ran' : 'failed', reason, costUsd, inboxItemId: item.id })
      const after = before !== null && deps.treeState ? await deps.treeState(cwd) : null
      producedDiff = after !== null && after !== before
    } finally {
      children.delete(spawned.nodeId)
      // The run is already settled; a ledger hiccup here must not rewrite it as failed.
      if (deps.cost) await deps.cost.end(costId, { producedDiff }).catch((err: unknown) => log.warn('routines.cost_end_failed', `Cannot close cost run for routine ${r.id}`, { cause: errText(err) }))
    }
  }

  /** Starts one run now; resolves once its history row exists (`done` = the whole run). */
  function fire(r: Routine, trigger: RunTrigger, opts: FireOptions = {}): FireResult {
    const scheduledFor = opts.scheduledFor ?? null
    if (opts.untrusted && !untrustedMayFire(routineTier(r.action))) return skip(r, trigger, `untrusted event cannot fire a ${routineTier(r.action)} routine`, scheduledFor)
    if (store.isRunning(r.id)) return skip(r, trigger, 'previous run still active', scheduledFor)
    const spent = store.spentToday(r.id)
    if (spent.runs >= r.budget.maxRunsPerDay) return skip(r, trigger, `budget: ${spent.runs} runs in 24h (cap ${r.budget.maxRunsPerDay})`, scheduledFor)
    if (r.budget.maxCostUsdPerDay !== null && spent.costUsd >= r.budget.maxCostUsdPerDay) {
      return skip(r, trigger, `budget: $${spent.costUsd.toFixed(2)} spent in 24h (cap $${r.budget.maxCostUsdPerDay})`, scheduledFor)
    }
    const cwd = deps.cwdOf(r.workspaceId)
    if (!cwd) return skip(r, trigger, 'workspace not found', scheduledFor)
    // Inserted synchronously after the checks: a concurrent fire sees it as busy.
    const run = store.addRun({ routineId: r.id, trigger, status: 'running', scheduledFor })
    deps.keepAwake.acquire()
    const done = execute(r, run.id, trigger, cwd)
      .catch((err: unknown) => settle(r, run.id, trigger, { status: 'failed', reason: `run error: ${errText(err)}` }))
      .finally(() => deps.keepAwake.release())
    return { run, done }
  }

  return {
    fire,
    /** Node ids of agents routines are running now (their own events must not re-fire routines). */
    isOwnChild: (nodeId: string | null): boolean => !!nodeId && children.has(nodeId),
  }
}

export type RoutineRunner = ReturnType<typeof createRoutineRunner>
