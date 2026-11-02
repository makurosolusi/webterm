// In-memory fake world + soak loop for scripts/soakCentralAutonomy.ts.
// Models the deps `createCentralAutonomy` asks for and asserts the scheduler invariants while it
// runs. No I/O, no wall-clock dependency: `--cycles` ticks finish in well under a second.
import {
  createCentralAutonomy,
  type AutonomyAuditEvent,
  type AutonomyDeps,
  type AutonomyPlan,
  type AutonomyPlanItem,
  type AutonomyProject,
  type TickResult,
} from '../src/server/central/centralAutonomy'

export interface SoakOptions {
  cycles: number
  projects: number
  failEvery: number
  pauseEvery: number
}

/** Violations are reported by `main` as an exit-1 failure, never as a thrown stack trace. */
export class InvariantError extends Error {}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message)
}

const PAUSE_WINDOW_TICKS = 5

interface FakeItem {
  id: string
  seq: number
  status: 'assigned' | 'running' | 'done'
}

interface FakeProjectState {
  id: string
  status: 'active' | 'paused'
  planStatus: 'active' | 'completed' | 'abandoned'
  version: number
  nextSeq: number
  items: FakeItem[]
}

export interface Metrics {
  runs: number
  failures: number
  ticks: number
  ticksRan: number
  ticksSkipped: number
  maxConcurrency: number
  maxRunsPerTick: number
  overlapProbes: number
  overlapRejections: number
  pausedSkipTicks: number
  /** Fake plan items kept alive by the harness itself; the heap delta is mostly this. */
  simulatedItems: number
  auditCounts: Record<string, number>
}

export interface SoakResult {
  metrics: Metrics
  heapBefore: number
  heapAfter: number
  wallMs: number
  quarantinedTicks: number
}

function makeProject(id: string): FakeProjectState {
  return {
    id,
    status: 'active',
    planStatus: 'active',
    version: 1,
    nextSeq: 2,
    items: [{ id: `${id}-i1`, seq: 1, status: 'assigned' }],
  }
}

function createFakeWorld(projectIds: readonly string[], failEvery: number) {
  const states = new Map<string, FakeProjectState>()
  for (const id of projectIds) states.set(id, makeProject(id))

  const audits: AutonomyAuditEvent[] = []
  const metrics: Metrics = {
    runs: 0,
    failures: 0,
    ticks: 0,
    ticksRan: 0,
    ticksSkipped: 0,
    maxConcurrency: 0,
    maxRunsPerTick: 0,
    overlapProbes: 0,
    overlapRejections: 0,
    pausedSkipTicks: 0,
    simulatedItems: 0,
    auditCounts: {},
  }
  let runIndex = 0
  let inFlight = 0
  let rotation = 0

  const deps: AutonomyDeps = {
    projects: (): readonly AutonomyProject[] => {
      const ids = [...states.keys()]
      const offset = ids.length === 0 ? 0 : rotation % ids.length
      const rotated = [...ids.slice(offset), ...ids.slice(0, offset)]
      return rotated.map((id) => ({ id, status: states.get(id)!.status }))
    },
    plan: (projectId): AutonomyPlan | null => {
      const state = states.get(projectId)
      if (state === undefined) return null
      const items: AutonomyPlanItem[] = state.items.map((item) => ({ ...item }))
      return { status: state.planStatus, version: state.version, items }
    },
    run: async (projectId, itemId, expectedVersion) => {
      inFlight += 1
      metrics.maxConcurrency = Math.max(metrics.maxConcurrency, inFlight)
      try {
        metrics.runs += 1
        runIndex += 1
        // Yield so a leaked concurrent run would be observable.
        await Promise.resolve()
        if (runIndex % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))

        const state = states.get(projectId)
        invariant(state !== undefined, `run for unknown project ${projectId}`)
        invariant(state.status !== 'paused', `run on paused project ${projectId}`)
        invariant(
          state.planStatus === 'active',
          `run on terminal plan ${projectId} status=${state.planStatus}`
        )
        const item = state.items.find((candidate) => candidate.id === itemId)
        invariant(item !== undefined, `run for unknown item ${itemId}`)
        invariant(item.status === 'assigned', `run on ${itemId} in status ${item.status}`)
        invariant(
          expectedVersion === state.version,
          `stale plan version for ${itemId}: got ${expectedVersion}, state ${state.version}`
        )

        if (failEvery > 0 && runIndex % failEvery === 0) {
          metrics.failures += 1
          // A failed run leaves the item `assigned`, exactly like a rejected route call.
          return { ok: false, code: 'fake_run_failed' }
        }

        // Success: mark this item done and append a new assigned item so work keeps coming.
        item.status = 'done'
        const seq = state.nextSeq
        state.nextSeq += 1
        state.items.push({ id: `${projectId}-i${seq}`, seq, status: 'assigned' })
        state.version += 1
        return { ok: true }
      } finally {
        inFlight -= 1
      }
    },
    audit: (event) => {
      audits.push(event)
      metrics.auditCounts[event.kind] = (metrics.auditCounts[event.kind] ?? 0) + 1
    },
    now: () => Date.now(),
  }

  return { deps, states, metrics, audits, rotate: (order: number) => (rotation = order) }
}

function heapUsed(): number {
  return process.memoryUsage().heapUsed
}

function maybeGc(): void {
  ;(globalThis as { gc?: () => void }).gc?.()
}

export async function runSoak(opts: SoakOptions): Promise<SoakResult> {
  const projectIds = Array.from({ length: opts.projects }, (_, index) => `p${index + 1}`)
  const world = createFakeWorld(projectIds, opts.failEvery)
  const autonomy = createCentralAutonomy(world.deps)
  const pausedUntil = new Map<string, number>()
  let quarantinedTicks = 0

  const isPausedAt = (projectId: string, tick: number): boolean => {
    const until = pausedUntil.get(projectId)
    return until !== undefined && tick < until
  }
  const syncStatuses = (tick: number): void => {
    for (const state of world.states.values()) {
      state.status = isPausedAt(state.id, tick) ? 'paused' : 'active'
    }
  }

  maybeGc()
  const heapBefore = heapUsed()
  const startedAt = performance.now()

  for (let tick = 0; tick < opts.cycles; tick += 1) {
    world.metrics.ticks += 1

    if (opts.pauseEvery > 0 && tick > 0 && tick % opts.pauseEvery === 0) {
      const target = projectIds[(tick / opts.pauseEvery) % projectIds.length]
      pausedUntil.set(target, tick + PAUSE_WINDOW_TICKS)
    }
    syncStatuses(tick)
    if ([...world.states.values()].some((state) => state.status === 'paused')) {
      world.metrics.pausedSkipTicks += 1
    }

    // Rotate row order so both projects actually receive ticks.
    world.rotate(tick)

    const runsBefore = world.metrics.runs
    const result: TickResult = await autonomy.tick()
    const delta = world.metrics.runs - runsBefore
    world.metrics.maxRunsPerTick = Math.max(world.metrics.maxRunsPerTick, delta)

    invariant(delta <= 1, `tick ${tick} ran ${delta} items (must be at most 1)`)
    if (result.ran) {
      invariant(delta === 1, `tick ${tick} reported ran but executed ${delta} runs`)
      invariant(
        !isPausedAt(result.projectId, tick),
        `tick ${tick} ran paused project ${result.projectId}`
      )
      const state = world.states.get(result.projectId)
      invariant(state !== undefined, `tick ${tick} ran unknown project ${result.projectId}`)
      invariant(state.planStatus === 'active', `tick ${tick} ran terminal plan ${result.projectId}`)
      world.metrics.ticksRan += 1
    } else {
      invariant(delta === 0, `tick ${tick} reported not-ran but executed ${delta} runs`)
      world.metrics.ticksSkipped += 1
    }

    // A project at/over its budget must not be selected again until a success or status change.
    for (const projectId of projectIds) {
      if (autonomy.failures(projectId) >= 3) quarantinedTicks += 1
    }

    // Deliberate concurrency probe: two overlapping tick() calls must not both run.
    if (tick === 1 || tick % 1000 === 0) {
      world.metrics.overlapProbes += 1
      const probeRunsBefore = world.metrics.runs
      const [first, second] = await Promise.all([autonomy.tick(), autonomy.tick()])
      const probeDelta = world.metrics.runs - probeRunsBefore
      invariant(probeDelta <= 1, `overlapping ticks ran ${probeDelta} items (must be at most 1)`)
      invariant(!(first.ran && second.ran), 'two overlapping ticks both reported a run')
      const rejected =
        (!first.ran && first.reason === 'overlap') ||
        (!second.ran && second.reason === 'overlap')
      if (rejected) world.metrics.overlapRejections += 1
    }

    invariant(
      world.metrics.maxConcurrency <= 1,
      `observed run concurrency ${world.metrics.maxConcurrency} (must be at most 1)`
    )
  }

  const wallMs = performance.now() - startedAt
  for (const state of world.states.values()) world.metrics.simulatedItems += state.items.length
  maybeGc()
  const heapAfter = heapUsed()

  return { metrics: world.metrics, heapBefore, heapAfter, wallMs, quarantinedTicks }
}
