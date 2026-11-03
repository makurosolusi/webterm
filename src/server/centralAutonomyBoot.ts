// Boot wiring for the central autonomous loop. The controller always exists (never `null`) and
// is hot-switchable: `onCapabilityChange('autonomy')` starts/stops the single timer, and every
// tick re-checks `isEnabled('autonomy')` + `isEnabled('workers')`, because a tick spawns a real
// worker through the same route a human would call. It never bypasses gates: approval-required
// runs still answer 409 (autonomy never approves; that is normal, not an anomaly), and a paused
// project or closed plan is skipped by the loop before the route is even asked.
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import {
  createCentralAutonomy,
  DEFAULT_AUTONOMY_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type AutonomyDeps,
  type AutonomyProject,
  type CentralAutonomyHandle,
} from './central/centralAutonomy'
import { MAX_INFLIGHT_ENV, RELIABILITY_ENV, maxInflightFromEnv, reliabilityEnabled } from './central/autonomyDispatch'
import { reconcileAgents } from './central/agents/agentReconciler'
import { createAgentStore } from './central/agents/agentStore'
import type { AgentRecord } from './central/contracts'
import { createBreakerStore } from './central/guard/breakerStore'
import { isEnabled, onCapabilityChange } from './featureCapabilities.runtime'
import { createPlanStore } from './orchestrator/plan'
import { orchestratorRunRoute } from './orchestratorRunApi'
import { createLogger } from './logs'

const logger = createLogger('central')

export interface AutonomyBootOptions {
  /** The process ledger runtime; `null` (ledger off / shadow failed) makes the controller a no-op. */
  runtime: LedgerRuntime | null
  env?: Record<string, string | undefined>
  intervalMs?: number
  /**
   * Reliability mode only: whether an agent's process/session still exists. When given, agents
   * claiming a live process but having none are moved to `orphaned` at boot.
   */
  agentAlive?: (agent: AgentRecord) => boolean | Promise<boolean>
  log?: (line: string) => void
  warn?: (line: string) => void
  /** Test seam: replace the ledger-backed project list / plan reader / worker run. */
  overrides?: Partial<Pick<AutonomyDeps, 'projects' | 'plan' | 'run'>>
}

/** Autonomy controller: the loop handle plus `dispose` to detach from capability changes. */
export type AutonomyController = CentralAutonomyHandle & { dispose(): void }

function listProjects(db: Database): AutonomyProject[] {
  const rows = db.query('SELECT id, status FROM project ORDER BY id ASC').all() as {
    id?: unknown
    status?: unknown
  }[]
  const projects: AutonomyProject[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue
    projects.push({ id: row.id, status: typeof row.status === 'string' ? row.status : 'active' })
  }
  return projects
}

/** Route errors are either `{error:'code'}` or `{error:{code,message}}`; never echo messages. */
function errorCode(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error
  if (typeof error === 'string') return error
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'run_failed'
}

async function runItem(
  runtime: LedgerRuntime,
  projectId: string,
  itemId: string,
  expectedVersion: number,
  env: Record<string, string | undefined>
): Promise<{ ok: boolean; code?: string }> {
  try {
    const result = await orchestratorRunRoute(
      { projectId, itemId, expectedVersion },
      // Workers are re-read per call: switching them off mid-flight blocks the next run. The
      // approval gate is untouched and still answers 409 when it applies.
      { ledger: runtime, enabled: isEnabled('workers', env) }
    )
    if (result.status === 200) {
      return (result.body as { ok?: unknown }).ok === false
        ? { ok: false, code: 'run_failed' }
        : { ok: true }
    }
    return { ok: false, code: errorCode(result.body) }
  } catch {
    // Never surface exception text: it can quote worktree paths or worker output.
    return { ok: false, code: 'internal' }
  }
}

/**
 * Builds the controller; starts the timer now only if autonomy is already on. Never `null`:
 * a missing ledger or an off capability just makes ticks no-ops, so a later hot enable works.
 */
export function startCentralAutonomyBoot(opts: AutonomyBootOptions): AutonomyController {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((line: string) => logger.info('central.autonomy.start', line))
  const warn = opts.warn ?? ((line: string) => logger.warn('central.autonomy.skip', line))
  const runtime = opts.runtime
  const plans = runtime ? createPlanStore(runtime.db) : null
  const intervalMs = opts.intervalMs ?? DEFAULT_AUTONOMY_INTERVAL_MS
  const reliable = runtime !== null && reliabilityEnabled(env[RELIABILITY_ENV])
  const live = (): boolean => isEnabled('autonomy', env) && isEnabled('workers', env)
  const inner = createCentralAutonomy({
    // Gate per tick (also covers the reliability waker, which ticks on its own): an empty
    // project list means nothing is sent and no failure budget is spent.
    projects: () => (runtime && live() ? (opts.overrides?.projects ?? (() => listProjects(runtime.db)))() : []),
    plan: opts.overrides?.plan ?? ((projectId) => plans?.get(projectId) ?? null),
    run:
      opts.overrides?.run ??
      ((projectId, itemId, expectedVersion) => runItem(runtime as LedgerRuntime, projectId, itemId, expectedVersion, env)),
    audit: (event) => {
      try {
        runtime?.ledger.event.appendEvent({
          actor: 'central',
          kind: event.kind,
          ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
          payload: { itemId: event.itemId, ok: event.ok, code: event.code, failures: event.failures },
          now: event.at,
        })
      } catch (err) {
        // A full/broken event log must not stop the loop; the tick already happened.
        logger.warn('central.autonomy.audit_failed', 'central autonomy audit append failed', {
          reason: err instanceof Error ? err.name : typeof err,
        })
      }
    },
    intervalMs,
    ...(reliable && runtime
      ? { dispatch: { maxInflight: maxInflightFromEnv(env[MAX_INFLIGHT_ENV]), breaker: createBreakerStore({ db: runtime.db, now: Date.now }) } }
      : {}),
  })

  let reconciled = false
  function start(): void {
    if (inner.running) return
    try {
      if (!runtime) return warn('central autonomy: ledger is off; nothing to run')
      if (reliable && opts.agentAlive && !reconciled) {
        reconciled = true // sekali per proses: seperti boot lama, bukan tiap hot-enable
        const isAlive = opts.agentAlive
        void reconcileAgents({ store: createAgentStore(runtime.db, Date.now), isAlive }).catch((err: unknown) =>
          warn(`central autonomy: agent reconcile failed (${err instanceof Error ? err.name : typeof err})`)
        )
      }
      inner.start()
      log(
        reliable
          ? 'central autonomy: on (reliability mode: non-blocking dispatch, wake + sweep, persistent breaker)'
          : `central autonomy: on (every ${intervalMs}ms, max ${DEFAULT_MAX_CONSECUTIVE_FAILURES} consecutive failures per project)`
      )
    } catch (err) {
      warn(`central autonomy: start failed (${err instanceof Error ? err.name : typeof err})`)
    }
  }
  // KE-5: stop hanya menghentikan timer. Worker yang sedang berjalan dibiarkan selesai sendiri.
  const stop = (): void => inner.stop()
  const unregister = onCapabilityChange('autonomy', { start, stop })
  if (isEnabled('autonomy', env)) start()

  return {
    tick: inner.tick,
    start,
    stop,
    get running() {
      return inner.running
    },
    failures: inner.failures,
    wake: inner.wake,
    get inflight() {
      return inner.inflight
    },
    drain: inner.drain,
    dispose: unregister,
  }
}
