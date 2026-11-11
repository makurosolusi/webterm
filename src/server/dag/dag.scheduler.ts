// Task DAG scheduler (F4-b): one tick = Orca's coordinator order (`coordinator.ts:155-161`):
// decided gates -> reblock tasks with pending gates -> dispatch ready tasks -> convergence.
//
// - Human-only gates (`coordinator-decision-gates.ts:51-60`): a gate is a ledger approval behind an
//   inbox card; only the approval's decision (canvas/inbox/Telegram, all UI-only) moves the task, and a
//   task whose gate is still pending is put back to `blocked` every tick whatever else changed it.
// - Escalation bound to the dispatch and its sender, 3-strike breaker (`coordinator-escalation-triage.ts:20-62`).
// - Stale base refused before any dispatch row exists (`coordinator-task-dispatch.ts:71-85`).
// - Leases: a ready task whose lease overlaps a running one waits; that is the automatic wave.
// - Completion only from the server verifier with the task's lease and verify_cmd (F4-c).
import { randomBytes } from 'node:crypto'
import { createLogger } from '../logs'
import type { ResolveInput } from '../models/modelLadder'
import { pickModel } from '../models/modelPick'
import { requestedModel } from '../models/modelRequest'
import { evidenceVerified } from '../orchestrator/orchestratorModel'
import type { AgentSpawnResult } from '../spawn/agentSpawn'
import type { ExecOutcome } from '../central/agents/execRunner'
import type { CompletionVerdict } from '../verifier/verifier.judge'
import {
  BREAKER_THRESHOLD, DAG_MAX_CONCURRENT, DISPATCH_STALE_THRESHOLD, EFFORT_SCALE,
  leasesOverlap, parseWorkerSignal, renderBrief, type DagTask, type DagTaskStatus,
} from './dag.model'
import { dagWorkerArgv, type DagPorts } from './dag.ports'
import { createDagStore, type Dag, type DagStore } from './dag.store'

const log = createLogger('dag')
/** The principal DAG workers are spawned under (K3 lineage root). */
export const DAG_PARENT = 'central'

export type EscalationResult = 'rejected' | 'retry' | 'circuit_broken'

export function createDagScheduler(ports: DagPorts) {
  const store: DagStore = createDagStore(ports.ctx)
  const inflight = new Map<string, Promise<void>>()
  // Why each task's last attempt failed, for the model ladder's escalation on the next dispatch.
  // ponytail: in memory, so a restart retries on the default tier; persist on dag_task if that matters.
  const lastFailure = new Map<string, NonNullable<ResolveInput['lastFailure']>>()
  let ticking = false

  function emit(kind: string, dag: Dag, task: DagTask | null, payload: Record<string, unknown> = {}, dedupeKey?: string): void {
    ports.record({
      kind: `dag.${kind}`, source: 'dag', actor: 'dag', trust: 'trusted',
      subject: task ? `dag_task:${task.id}` : `dag:${dag.id}`,
      payload: { dagId: dag.id, ...(task ? { taskId: task.id, key: task.key } : {}), ...payload },
      ...(dedupeKey ? { dedupeKey } : {}),
    })
  }

  function setStatus(dag: Dag, task: DagTask, status: DagTaskStatus, patch: Parameters<DagStore['setTask']>[1] = {}, payload: Record<string, unknown> = {}): void {
    store.setTask(task.id, { ...patch, status })
    emit(`task.${status}`, dag, task, payload)
  }

  /** Orca `failDispatch`: below the threshold the task is requeued, the 3rd failure breaks the circuit. */
  function failAttempt(dag: Dag, task: DagTask, dispatchId: string | null, reason: string, failure: ResolveInput['lastFailure'] = null): EscalationResult {
    if (dispatchId) store.endDispatch(dispatchId, 'failed')
    if (failure) lastFailure.set(task.id, failure)
    else lastFailure.delete(task.id)
    const failures = task.failureCount + 1
    if (failures >= BREAKER_THRESHOLD) {
      store.setTask(task.id, { status: 'failed', failureCount: failures, lastError: `Circuit broken: ${reason}` })
      emit('task.circuit_broken', dag, task, { failures, reason })
      return 'circuit_broken'
    }
    store.setTask(task.id, { status: 'pending', failureCount: failures, lastError: reason })
    emit('task.requeued', dag, task, { failures, threshold: BREAKER_THRESHOLD, reason })
    return 'retry'
  }

  function raiseGate(dag: Dag, task: DagTask, dispatchId: string | null, nodeId: string | null, question: string, options: string[] | null): void {
    const approvalId = ports.openGate({ projectId: dag.projectId, title: `${dag.title} · ${task.key}: ${question}`, body: question, options, nodeId })
    const gate = store.addGate({ dagId: dag.id, taskId: task.id, dispatchId, approvalId, question, options })
    if (dispatchId) store.endDispatch(dispatchId, 'gated')
    store.setTask(task.id, { status: 'blocked' })
    emit('gate.opened', dag, task, { gateId: gate.id, approvalId, dispatchId, options })
  }

  /**
   * Escalation from a worker, bound to the exact dispatch AND the node that owns it (anti-spoof,
   * Orca `:20-45`). Counts one breaker strike for the task.
   */
  function escalate(input: { taskId: string; dispatchId: string; from: string; reason: string }): EscalationResult {
    const task = store.task(input.taskId)
    const dispatch = store.dispatch(input.dispatchId)
    const dag = task ? store.get(task.dagId) : null
    if (!task || !dag || task.status === 'done' || task.status === 'failed') return 'rejected'
    const why = !dispatch || dispatch.taskId !== task.id ? 'dispatch does not own the task'
      : dispatch.nodeId !== input.from ? 'sender does not own the dispatch'
        : dispatch.status !== 'running' ? `dispatch is ${dispatch.status}` : null
    if (why) {
      emit('escalation.rejected', dag, task, { dispatchId: input.dispatchId, from: input.from, why })
      return 'rejected'
    }
    store.setEscalation(input.dispatchId, input.reason)
    emit('escalation.accepted', dag, task, { dispatchId: input.dispatchId })
    return failAttempt(dag, task, input.dispatchId, `escalated: ${input.reason}`)
  }

  /**
   * The worker process ended: signals first (they only block or fail), then the verifier decides.
   * Resolves to whether the worker produced a diff (verifier's changed files); undefined = a gate is
   * waiting on a human, which is not a wasted run for the low-ROI pause.
   */
  async function settle(dispatchId: string, outcome: ExecOutcome): Promise<boolean | undefined> {
    const dispatch = store.dispatch(dispatchId)
    const task = dispatch ? store.task(dispatch.taskId) : null
    const dag = task ? store.get(task.dagId) : null
    if (!dispatch || !task || !dag || dispatch.status !== 'running') return false
    const result = outcome.lastEvent?.['result']
    const output = typeof result === 'string' ? result : outcome.tail
    const signal = parseWorkerSignal(output)
    if (signal?.kind === 'gate') { raiseGate(dag, task, dispatch.id, dispatch.nodeId, signal.question, signal.options ?? null); return undefined }
    if (signal?.kind === 'escalate') { escalate({ taskId: task.id, dispatchId, from: dispatch.nodeId, reason: signal.reason }); return false }
    let verdict: CompletionVerdict
    try {
      verdict = await ports.verify({
        taskId: task.id, cwd: dispatch.worktree ?? dag.repo, lease: task.brief.lease, verifyCmd: task.brief.verifyCmd,
        baseRef: dispatch.baseSha ?? dag.baseRef, timeoutMs: EFFORT_SCALE[task.brief.effort].timeoutMs, claim: output,
      })
    } catch (err) {
      failAttempt(dag, task, dispatchId, `verifier error: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    ports.report({ verdict, taskId: task.id, worker: `${dag.title}: ${task.key}`, projectId: dag.projectId, nodeId: dispatch.nodeId })
    // Only sealed server evidence (verifier.seal) with the lease respected can make a task done.
    if (verdict.status === 'done' && evidenceVerified(verdict.evidence)) {
      store.endDispatch(dispatchId, 'succeeded')
      lastFailure.delete(task.id)
      setStatus(dag, task, 'done', { lastError: null }, { dispatchId, summary: verdict.summary, files: verdict.filesChanged.length })
    } else {
      // A worker killed by its wall clock retries with more effort first; the verifier's reason otherwise.
      failAttempt(dag, task, dispatchId, verdict.message, outcome.timedOut ? 'timeout' : verdict.reason === 'verified' ? null : verdict.reason)
    }
    converge(dag)
    return verdict.filesChanged.length > 0
  }

  async function dispatchTask(dag: Dag, task: DagTask): Promise<void> {
    const dispatchId = randomBytes(8).toString('hex')
    store.setTask(task.id, { status: 'running' }) // claimed before the first await
    let alloc: { path: string; branch: string; baseSha: string }
    try {
      alloc = await ports.allocate(dag, task, dispatchId)
    } catch (err) {
      failAttempt(dag, task, null, `worktree: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const nodeId = `dag-${dispatchId}`
    store.addDispatch({ id: dispatchId, taskId: task.id, nodeId, worktree: alloc.path, branch: alloc.branch, baseSha: alloc.baseSha })
    const prompt = renderBrief(task)
    // attempt = failed attempts so far; the breaker (BREAKER_THRESHOLD) still ends the task, the ladder only picks the model.
    const pick = pickModel(ports.ctx.db, {
      kind: 'dag-worker', complexity: task.brief.effort, attempt: task.failureCount, lastFailure: lastFailure.get(task.id) ?? null,
      projectId: dag.projectId, runRef: `dag:${dag.id}`,
    }, ports.ctx.now)
    let res: AgentSpawnResult
    try {
      res = await ports.spawn({
        mode: 'headless', door: 'orchestrator', parent: DAG_PARENT, cwd: alloc.path, nodeId, prompt, title: `${dag.title}: ${task.key}`,
        headless: { argv: dagWorkerArgv(prompt, task.brief.tools, pick), timeoutMs: EFFORT_SCALE[task.brief.effort].timeoutMs },
      })
    } catch (err) {
      res = { ok: false, code: 'spawn_invalid', message: err instanceof Error ? err.message : String(err) }
    }
    if (!res.ok || !res.handle) {
      failAttempt(dag, task, dispatchId, `spawn: ${res.ok ? 'no process handle' : res.message}`)
      return
    }
    emit('task.running', dag, task, { dispatchId, nodeId, branch: alloc.branch, effort: task.brief.effort, tier: pick.tier, model: pick.model, modelReason: pick.reason })
    const handle = res.handle
    const done = (async () => {
      let costId: string | null = null
      let producedDiff: boolean | undefined = false
      try {
        if (ports.cost) costId = await ports.cost.begin({ kind: 'dag', ref: dag.id, label: `${dag.title}: ${task.key}`, nodeId, tier: pick.tier, model: requestedModel(pick.model) })
        producedDiff = await settle(dispatchId, await handle.done)
      } finally {
        if (ports.cost) await ports.cost.end(costId, { ...(producedDiff === undefined ? {} : { producedDiff }) })
      }
    })()
      .catch((err: unknown) => log.error('dag.settle.failed', `settle of dispatch ${dispatchId} failed`, { cause: err instanceof Error ? err.message : String(err) }))
      .finally(() => inflight.delete(dispatchId))
    inflight.set(dispatchId, done)
  }

  /** Decisions made on any surface: approved -> unblock (gate node done), denied -> failed, expired -> re-asked. */
  function syncGates(dag: Dag): void {
    for (const gate of store.pendingGates(dag.id)) {
      const task = store.task(gate.taskId)
      const a = store.approvalStatus(gate.approvalId)
      if (!task || !a) continue
      if (a.status === 'approved') {
        store.decideGate(gate.id, 'approved', a.by ?? 'human')
        const decision = task.decision ?? `${gate.question}: approved`
        if (task.kind === 'gate') setStatus(dag, task, 'done', { decision }, { gateId: gate.id })
        else setStatus(dag, task, 'pending', { decision }, { gateId: gate.id, unblocked: true })
        emit('gate.approved', dag, task, { gateId: gate.id, by: a.by })
      } else if (a.status === 'rejected') {
        store.decideGate(gate.id, 'denied', a.by ?? 'human')
        setStatus(dag, task, 'failed', { lastError: 'decision gate denied' }, { gateId: gate.id })
        emit('gate.denied', dag, task, { gateId: gate.id, by: a.by })
      } else if (a.expired) {
        // A gate never times out into a decision: only a human resolves it, so the card is re-asked.
        const approvalId = ports.openGate({ projectId: dag.projectId, title: `${dag.title} · ${task.key}: ${gate.question}`, body: gate.question, options: gate.options, nodeId: null })
        store.renewGate(gate.id, approvalId)
        emit('gate.renewed', dag, task, { gateId: gate.id, approvalId })
      }
    }
  }

  /** Orca `reblockTasksWithPendingGates`: only explicit human gate resolution may unblock. */
  function reblock(dag: Dag): void {
    for (const gate of store.pendingGates(dag.id)) {
      const task = store.task(gate.taskId)
      if (task && task.status !== 'blocked') setStatus(dag, task, 'blocked', {}, { gateId: gate.id, reblocked: true })
    }
  }

  async function dispatchReady(dag: Dag): Promise<void> {
    const tasks = store.tasks(dag.id)
    const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.key))
    const running = tasks.filter((t) => t.status === 'running')
    let behind: number | null | undefined
    for (const task of tasks) {
      if (task.status !== 'pending' || !task.deps.every((d) => done.has(d))) continue
      if (task.kind === 'gate') { raiseGate(dag, task, null, null, task.brief.objective, task.brief.options ?? null); continue }
      if (running.length >= DAG_MAX_CONCURRENT) break
      if (!ports.workersEnabled()) { emit('dispatch.workers_off', dag, null, {}, `dag:${dag.id}:workers_off`); break }
      const holder = running.find((r) => leasesOverlap(r.brief.lease, task.brief.lease))
      if (holder) { emit('task.lease_wait', dag, task, { holder: holder.key }, `dag:${task.id}:lease:${holder.id}`); continue }
      if (!task.brief.allowStaleBase) {
        if (behind === undefined) behind = await ports.behind(dag) // one probe per tick (Orca `:256`)
        if (behind !== null && behind > DISPATCH_STALE_THRESHOLD) {
          emit('dispatch.stale_base_refused', dag, task, { behind, threshold: DISPATCH_STALE_THRESHOLD, base: dag.baseBranch }, `dag:${task.id}:stale:${behind}`)
          continue
        }
      }
      if (ports.cost) {
        // One scope per dag, so a refusal holds every task of it; the task stays pending and retries next tick.
        const g = await ports.cost.gate({ kind: 'dag', ref: dag.id })
        if (!g.allowed) {
          const code = g.reason?.startsWith('paused:') ? 'roi_paused' : 'budget'
          emit('dispatch.cost_refused', dag, task, { reason: code, detail: g.reason, estimateMicros: g.estimate.medianMicros }, `dag:${dag.id}:cost:${code}:${Math.floor(ports.ctx.now() / 86_400_000)}`)
          break
        }
      }
      await dispatchTask(dag, task)
      const now = store.task(task.id)
      if (now?.status === 'running') running.push(now)
    }
  }

  /** `coordinator-dag-convergence.ts`: all done, stuck on gates, or no way forward. */
  function converge(dag: Dag): void {
    const fresh = store.get(dag.id)
    if (!fresh || fresh.status !== 'active') return
    const tasks = store.tasks(dag.id)
    if (tasks.every((t) => t.status === 'done')) { store.setDagStatus(dag.id, 'done'); emit('done', dag, null); return }
    const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.key))
    const live = tasks.some((t) => t.status === 'running' || (t.status === 'pending' && t.deps.every((d) => done.has(d))))
    if (live) return
    if (tasks.some((t) => t.status === 'blocked')) { emit('stalled', dag, null, { hint: 'Resolve decision gates to continue' }, `dag:${dag.id}:stalled:${tasks.filter((t) => t.status === 'blocked').length}`); return }
    store.setDagStatus(dag.id, 'failed')
    emit('failed', dag, null, { failed: tasks.filter((t) => t.status === 'failed').map((t) => t.key) })
  }

  async function tickDag(dag: Dag): Promise<void> {
    syncGates(dag)
    reblock(dag)
    await dispatchReady(dag)
    converge(dag)
  }

  return {
    store,
    escalate,
    /** One pass over every active dag; a concurrent call is a no-op. */
    async tick(): Promise<void> {
      if (ticking) return
      ticking = true
      try {
        for (const dag of store.active()) await tickDag(dag)
      } finally {
        ticking = false
      }
    },
    /** Boot: a `running` dispatch with no live process (server restarted) is abandoned, not a strike. */
    recoverOrphans(): void {
      for (const d of store.runningDispatches()) {
        if (inflight.has(d.id)) continue
        store.endDispatch(d.id, 'abandoned')
        const task = store.task(d.taskId)
        const dag = task ? store.get(task.dagId) : null
        if (task && dag && task.status === 'running') setStatus(dag, task, 'pending', {}, { dispatchId: d.id, abandoned: true })
      }
    },
    created(dag: Dag): void { emit('created', dag, null, { tasks: store.tasks(dag.id).length, by: dag.createdBy }) },
    /** Resolves once every in-flight worker settled (tests, shutdown). */
    async drain(): Promise<void> { while (inflight.size > 0) await Promise.all([...inflight.values()]) },
  }
}

export type DagScheduler = ReturnType<typeof createDagScheduler>
