// Central autonomous loop: one already-assigned plan item per tick, across all projects.
// It is a scheduler, not an authority: it never creates plans/tasks, never approves an
// approval, never touches a `running` item. Selection is read-only; the only mutation is the
// injected `run` call, which is the same route a human would hit. The loop is off unless the
// caller arms it, and consecutive failures quarantine a project instead of retrying forever.

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
  kind: 'autonomy.run' | 'autonomy.budget_exhausted' | 'autonomy.tick_error'
  at: number
  projectId?: string
  itemId?: string
  ok?: boolean
  code?: string
  failures?: number
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
}

export type TickResult =
  | { ran: false; reason: 'overlap' | 'no_projects' | 'no_eligible' | 'error' }
  | { ran: true; projectId: string; itemId: string; ok: boolean; code?: string }

/** Concurrent `tick()` calls return `{ran:false, reason:'overlap'}`. */
export interface CentralAutonomyHandle {
  tick(): Promise<TickResult>
  /** Starts the unref'd interval. Idempotent. */
  start(): void
  stop(): void
  readonly running: boolean
  /** Consecutive failures for one project (diagnostics/tests). */
  failures(projectId: string): number
}

export const DEFAULT_AUTONOMY_INTERVAL_MS = 30_000
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
const PROJECT_PAUSED = 'paused'
const TERMINAL = ['completed', 'abandoned']

/** `WEBTERM_CENTRAL_AUTONOMY=on` arms the loop; every other value (and unset) is off. */
export function autonomyEnabled(
  raw: string | undefined = process.env.WEBTERM_CENTRAL_AUTONOMY
): boolean {
  return (raw ?? '').trim().toLowerCase() === 'on'
}

function isTerminal(status: string): boolean {
  return TERMINAL.includes(status)
}
/** Lowest-`seq` item in exactly `assigned`; running/done/failed are never selected. */
function nextItem(plan: AutonomyPlan): AutonomyPlanItem | null {
  let best: AutonomyPlanItem | null = null
  for (const item of plan.items) {
    if (item.status !== 'assigned') continue
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

  async function tick(): Promise<TickResult> {
    if (ticking) return { ran: false, reason: 'overlap' }
    ticking = true
    try {
      let projects: readonly AutonomyProject[]
      try {
        projects = deps.projects()
      } catch {
        return { ran: false, reason: 'error' }
      }
      if (projects.length === 0) return { ran: false, reason: 'no_projects' }
      for (const project of projects) {
        // A status flip (pause/resume/etc.) is an operator signal: forget the failure budget.
        const previous = lastStatus.get(project.id)
        if (previous !== undefined && previous !== project.status) consecutive.delete(project.id)
        lastStatus.set(project.id, project.status)

        if (project.status === PROJECT_PAUSED) continue
        if ((consecutive.get(project.id) ?? 0) >= maxFailures) continue

        let plan: AutonomyPlan | null
        try {
          plan = deps.plan(project.id)
        } catch {
          audit({ kind: 'autonomy.tick_error', at: now(), projectId: project.id, code: 'plan_read' })
          continue
        }
        if (plan === null || isTerminal(plan.status)) continue
        const item = nextItem(plan)
        if (item === null) continue

        let result: { ok: boolean; code?: string }
        try {
          result = await deps.run(project.id, item.id, plan.version)
        } catch {
          // A thrown run is a failed run, not a crashed loop: no stack details are recorded.
          result = { ok: false, code: 'internal' }
        }
        if (result.ok) {
          consecutive.delete(project.id)
          audit({ kind: 'autonomy.run', at: now(), projectId: project.id, itemId: item.id, ok: true })
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
    if (timer !== null) return
    timer = setInterval(() => {
      void tick().catch(() => {})
    }, intervalMs)
    // A scheduler must never be the reason `bun src/server/index.ts` fails to exit.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function stop(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  return {
    tick,
    start,
    stop,
    get running() {
      return timer !== null
    },
    failures: (projectId: string) => consecutive.get(projectId) ?? 0,
  }
}
