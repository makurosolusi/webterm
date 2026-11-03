// Boot wiring for the central autonomous loop. Off by default: it becomes live only when
// WEBTERM_CENTRAL_AUTONOMY=on AND the orchestrator run surface is armed, because a tick
// spawns a real worker through the same route a human would call. It never bypasses gates:
// approval-required runs still answer 409, and a paused project or closed plan is skipped by
// the loop before the route is even asked. One runtime, one server: this only owns a timer.
import type { Database } from 'bun:sqlite'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import {
  createCentralAutonomy,
  autonomyEnabled as autonomyFlagOn,
  DEFAULT_AUTONOMY_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type AutonomyProject,
  type CentralAutonomyHandle,
} from './central/centralAutonomy'
import { MAX_INFLIGHT_ENV, RELIABILITY_ENV, maxInflightFromEnv, reliabilityEnabled } from './central/autonomyDispatch'
import { reconcileAgents } from './central/agents/agentReconciler'
import { createAgentStore } from './central/agents/agentStore'
import type { AgentRecord } from './central/contracts'
import { createBreakerStore } from './central/guard/breakerStore'
import { createPlanStore } from './orchestrator/plan'
import { orchestratorRunRoute } from './orchestratorRunApi'
import { orchestratorRunEnabled, orchestratorRunRequireApproval } from './orchestratorRunModel'
import { createLogger } from './logs'

const logger = createLogger('central')

export interface AutonomyBootOptions {
  /** The process ledger runtime; `null` (ledger off / shadow failed) refuses to boot. */
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
}

/** Pure env gate, exported so the boot decision is testable without a database. */
export function autonomyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return autonomyFlagOn(env.WEBTERM_CENTRAL_AUTONOMY)
}

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
  expectedVersion: number
): Promise<{ ok: boolean; code?: string }> {
  try {
    const result = await orchestratorRunRoute(
      { projectId, itemId, expectedVersion },
      // `enabled: true` because boot already required WEBTERM_ORCHESTRATOR_RUN=on; the
      // approval gate is untouched and still answers 409 when it applies.
      { ledger: runtime, enabled: true }
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
 * Starts the loop or returns `null`. Fail-closed on every missing prerequisite, with one log
 * line explaining why, so an operator never believes autonomy is running when it is not.
 */
export function startCentralAutonomyBoot(
  opts: AutonomyBootOptions
): CentralAutonomyHandle | null {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((line: string) => logger.info('central.autonomy.start', line))
  const warn = opts.warn ?? ((line: string) => logger.warn('central.autonomy.skip', line))
  if (!autonomyEnabled(env)) return null
  if (opts.runtime === null) {
    warn('central autonomy: ledger is off; not starting')
    return null
  }
  if (!orchestratorRunEnabled(env)) {
    warn('central autonomy: WEBTERM_ORCHESTRATOR_RUN is not on; not starting')
    return null
  }
  if (orchestratorRunRequireApproval(env)) {
    warn(
      'central autonomy: WEBTERM_RUN_REQUIRE_APPROVAL=on; ticks without an approved ' +
        'approval will return 409 (autonomy never approves)'
    )
  }

  const runtime = opts.runtime
  const plans = createPlanStore(runtime.db)
  const intervalMs = opts.intervalMs ?? DEFAULT_AUTONOMY_INTERVAL_MS
  const reliable = reliabilityEnabled(env[RELIABILITY_ENV])
  if (reliable && opts.agentAlive) {
    const isAlive = opts.agentAlive
    void reconcileAgents({ store: createAgentStore(runtime.db, Date.now), isAlive }).catch((err: unknown) =>
      warn(`central autonomy: agent reconcile failed (${err instanceof Error ? err.message : typeof err})`)
    )
  }
  const handle = createCentralAutonomy({
    projects: () => listProjects(runtime.db),
    plan: (projectId) => plans.get(projectId),
    run: (projectId, itemId, expectedVersion) =>
      runItem(runtime, projectId, itemId, expectedVersion),
    audit: (event) => {
      try {
        runtime.ledger.event.appendEvent({
          actor: 'central',
          kind: event.kind,
          ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
          payload: {
            itemId: event.itemId,
            ok: event.ok,
            code: event.code,
            failures: event.failures,
          },
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
    ...(reliable
      ? {
          dispatch: {
            maxInflight: maxInflightFromEnv(env[MAX_INFLIGHT_ENV]),
            breaker: createBreakerStore({ db: runtime.db, now: Date.now }),
          },
        }
      : {}),
  })
  handle.start()
  log(
    reliable
      ? 'central autonomy: on (reliability mode: non-blocking dispatch, wake + sweep, persistent breaker)'
      : `central autonomy: on (every ${intervalMs}ms, max ${DEFAULT_MAX_CONSECUTIVE_FAILURES} ` +
          'consecutive failures per project)'
  )
  return handle
}
