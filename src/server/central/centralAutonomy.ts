// Central autonomous loop: one already-assigned plan item per tick, across all projects.
// It is a scheduler, not an authority: it never creates plans/tasks, never approves an
// approval, never touches a `running` item. Selection is read-only; the only mutation is the
// injected `run` call, which is the same route a human would hit. The loop is off unless the
// caller arms it, and consecutive failures quarantine a project instead of retrying forever.

import { flagOn } from '../envFlag'
import { isEnabled } from '../featureCapabilities.runtime'
import { createLogger } from '../logs'
import { createDispatcher, type DispatchJob, type DispatchResult, type Dispatcher } from './autonomyDispatch'
import type { SyncBreaker } from './guard/breakerStore'
import { createWaker, type Waker } from './wake'

const log = createLogger('central')

/** Minimal project row the loop needs; `status` is the ledger project.status. */
export interface AutonomyProject {
  id: string
  status: string
}

/** The plan slice the loop reads. Unknown statuses are treated as non-terminal. */
export interface AutonomyPlanItem {
  id: string
  seq: number
  status: string
}

export interface AutonomyPlan {
  status: string
  version: number
  items: readonly AutonomyPlanItem[]
}

/** Audit payload; the boot layer maps `kind` onto a ledger event row. */
export interface AutonomyAuditEvent {
  kind: 'autonomy.run' | 'autonomy.budget_exhausted' | 'autonomy.tick_error' | 'autonomy.breaker_open'
  at: number
  projectId?: string
  itemId?: string
  ok?: boolean
  code?: string
  failures?: number
}

/** Non-blocking dispatch (bounded workers, wake + sweep, optional persistent breaker). Absent = legacy loop. */
export interface AutonomyDispatchConfig {
  /** Global worker cap; default `DEFAULT_MAX_INFLIGHT_WORKERS`. A function is re-read per dispatch. */
  maxInflight?: number | (() => number)
  breaker?: SyncBreaker
  /** Replaces `intervalMs` as the safety net in this mode; default 60 s. */
  sweepMs?: number
  debounceMs?: number
}

export interface AutonomyDeps {
  projects(): readonly AutonomyProject[]
  plan(projectId: string): AutonomyPlan | null
  run(
    projectId: string,
    itemId: string,
    expectedVersion: number
  ): Promise<{ ok: boolean; code?: string }>
  audit(event: AutonomyAuditEvent): void
  now?: () => number
  intervalMs?: number
  /** Default 3. Reached budget skips the project until a success or a status change. */
  maxConsecutiveFailures?: number
  dispatch?: AutonomyDispatchConfig
}

export type TickResult =
  | { ran: false; reason: 'overlap' | 'no_projects' | 'no_eligible' | 'error' | 'saturated' }
  /** In dispatch mode `ok` means "started" (the first job) and `dispatched` counts jobs started this tick. */
  | { ran: true; projectId: string; itemId: string; ok: boolean; code?: string; dispatched?: number }

/** Concurrent `tick()` calls return `{ran:false, reason:'overlap'}`. */
export interface CentralAutonomyHandle {
  tick(): Promise<TickResult>
  /** Starts the unref'd interval. Idempotent. */
  start(): void
  stop(): void
  readonly running: boolean
  /** Consecutive failures for one project (diagnostics/tests). */
  failures(projectId: string): number
  /** Dispatch mode: schedules a debounced tick (task settled, plan assigned...). No-op in legacy mode. */
  wake(reason: string): void
  /** Workers currently in flight (always 0 in legacy mode). */
  readonly inflight: number
  /** Resolves when in-flight workers settled (shutdown/tests). */
  drain(): Promise<void>
}

export const DEFAULT_AUTONOMY_INTERVAL_MS = 30_000
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
const PROJECT_PAUSED = 'paused'
const TERMINAL = ['completed', 'abandoned']

/** Autonomy on = kemampuan `autonomy` (beserta prasyaratnya) on; string mentah dipertahankan untuk pemanggil lama. */
export function autonomyEnabled(env: NodeJS.ProcessEnv | string | undefined = process.env): boolean {
  return typeof env === 'string' ? flagOn(env) : isEnabled('autonomy', env)
}

function isTerminal(status: string): boolean {
  return TERMINAL.includes(status)
}
/** Lowest-`seq` item in exactly `assigned`; running/done/failed are never selected. */
function nextItem(plan: AutonomyPlan, skip?: (itemId: string) => boolean): AutonomyPlanItem | null {
  let best: AutonomyPlanItem | null = null
  for (const item of plan.items) {
    if (item.status !== 'assigned' || skip?.(item.id)) continue
    if (best === null || item.seq < best.seq) best = item
  }
  return best
}

export function createCentralAutonomy(deps: AutonomyDeps): CentralAutonomyHandle {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? DEFAULT_AUTONOMY_INTERVAL_MS
  const maxFailures = Math.max(1, deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES)
  const consecutive = new Map<string, number>()
  const lastStatus = new Map<string, string>()
  let ticking = false
  let timer: ReturnType<typeof setInterval> | null = null

  function audit(event: AutonomyAuditEvent): void {
    const fields = { projectId: event.projectId, itemId: event.itemId, ok: event.ok, code: event.code, failures: event.failures }
    if (event.kind !== 'autonomy.run' || event.ok === false) log.warn(`central.${event.kind}`, `central ${event.kind}`, fields)
    else log.info(`central.${event.kind}`, `central ${event.kind}`, fields)
    try {
      deps.audit(event)
    } catch {
      // An audit sink failure must not abort a tick that already did its one run.
    }
  }

  function recordFailure(projectId: string, itemId: string, code: string | undefined): void {
    const count = (consecutive.get(projectId) ?? 0) + 1
    consecutive.set(projectId, count)
    audit({ kind: 'autonomy.run', at: now(), projectId, itemId, ok: false, code })
    if (count >= maxFailures) {
      audit({
        kind: 'autonomy.budget_exhausted',
        at: now(),
        projectId,
        failures: count,
      })
    }
  }

  function readProjects(): readonly AutonomyProject[] | null {
    try {
      return deps.projects()
    } catch {
      log.warn('central.autonomy.tick_error', 'central autonomy: project list failed', { code: 'projects_read' })
      return null
    }
  }

  /** Plan of a project the loop may act on, or null (paused, quarantined, unreadable, terminal). */
  function planFor(project: AutonomyProject): AutonomyPlan | null {
    // A status flip (pause/resume/etc.) is an operator signal: forget the failure budget.
    const previous = lastStatus.get(project.id)
    if (previous !== undefined && previous !== project.status) consecutive.delete(project.id)
    lastStatus.set(project.id, project.status)

    if (project.status === PROJECT_PAUSED) return null
    if ((consecutive.get(project.id) ?? 0) >= maxFailures) return null

    let plan: AutonomyPlan | null
    try {
      plan = deps.plan(project.id)
    } catch {
      audit({ kind: 'autonomy.tick_error', at: now(), projectId: project.id, code: 'plan_read' })
      return null
    }
    return plan === null || isTerminal(plan.status) ? null : plan
  }

  function recordSuccess(projectId: string, itemId: string): void {
    consecutive.delete(projectId)
    audit({ kind: 'autonomy.run', at: now(), projectId, itemId, ok: true })
  }
  const dispatcher: Dispatcher | null = deps.dispatch ? createDispatcher({
    maxInflight: deps.dispatch.maxInflight,
    breaker: deps.dispatch.breaker,
    onSettled(job: DispatchJob, result: DispatchResult, breakerOpened: boolean) {
      if (result.ok) {
        recordSuccess(job.projectId, job.itemId)
        waker?.wake('worker_settled')
        return
      }
      recordFailure(job.projectId, job.itemId, result.code)
      if (breakerOpened) audit({ kind: 'autonomy.breaker_open', at: now(), projectId: job.projectId, itemId: job.itemId, code: result.code })
    },
  }) : null
  const waker: Waker | null = dispatcher ? createWaker({
    onWake: () => tick(),
    sweepMs: deps.dispatch?.sweepMs,
    debounceMs: deps.dispatch?.debounceMs,
  }) : null
  let cursor = 0
  /** Claims at most one item per project (round-robin start) and launches it; never awaits a worker. */
  function dispatchTick(d: Dispatcher): TickResult {
    const projects = readProjects()
    if (projects === null) return { ran: false, reason: 'error' }
    if (projects.length === 0) return { ran: false, reason: 'no_projects' }
    const offset = cursor++ % projects.length
    const started: DispatchJob[] = []
    let saturated = false
    for (let i = 0; i < projects.length && !saturated; i++) {
      const project = projects[(offset + i) % projects.length]
      const plan = planFor(project)
      if (plan === null) continue
      const item = nextItem(plan, (id) => d.has({ projectId: project.id, itemId: id }))
      if (item === null) continue
      const job = { projectId: project.id, itemId: item.id }
      const outcome = d.start(job, () => deps.run(project.id, item.id, plan.version))
      if (outcome === 'started') started.push(job)
      else if (outcome === 'saturated') saturated = true
    }
    if (started.length === 0) return { ran: false, reason: saturated ? 'saturated' : 'no_eligible' }
    return { ran: true, ...started[0], ok: true, dispatched: started.length }
  }

  async function tick(): Promise<TickResult> {
    if (dispatcher) return dispatchTick(dispatcher)
    if (ticking) return { ran: false, reason: 'overlap' }
    ticking = true
    try {
      const projects = readProjects()
      if (projects === null) return { ran: false, reason: 'error' }
      if (projects.length === 0) return { ran: false, reason: 'no_projects' }
      for (const project of projects) {
        const plan = planFor(project)
        if (plan === null) continue
        const item = nextItem(plan)
        if (item === null) continue

        let result: { ok: boolean; code?: string }
        try {
          result = await deps.run(project.id, item.id, plan.version)
        } catch (err) {
          // A thrown run is a failed run, not a crashed loop: only the message is logged, never the stack.
          log.error('central.autonomy.run_threw', 'central autonomy: run threw', { projectId: project.id, itemId: item.id, error: err instanceof Error ? err.message : String(err) })
          result = { ok: false, code: 'internal' }
        }
        if (result.ok) {
          recordSuccess(project.id, item.id)
          return { ran: true, projectId: project.id, itemId: item.id, ok: true }
        }
        recordFailure(project.id, item.id, result.code)
        const code = result.code === undefined ? {} : { code: result.code }
        return { ran: true, projectId: project.id, itemId: item.id, ok: false, ...code }
      }
      return { ran: false, reason: 'no_eligible' }
    } finally {
      ticking = false
    }
  }

  function start(): void {
    if (waker) return waker.start()
    if (timer !== null) return
    timer = setInterval(() => {
      void tick().catch(() => {})
    }, intervalMs)
    // A scheduler must never be the reason `bun src/server/index.ts` fails to exit.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function stop(): void {
    if (waker) {
      if (!waker.running) return
      waker.stop()
      log.info('central.autonomy.stop', 'central autonomy stopped')
      return
    }
    if (timer === null) return
    clearInterval(timer)
    timer = null
    log.info('central.autonomy.stop', 'central autonomy stopped')
  }

  return {
    tick,
    start,
    stop,
    get running() {
      return waker ? waker.running : timer !== null
    },
    failures: (projectId: string) => consecutive.get(projectId) ?? 0,
    wake: (reason) => waker?.wake(reason),
    get inflight() {
      return dispatcher?.size ?? 0
    },
    drain: () => dispatcher?.drain() ?? Promise.resolve(),
  }
}
