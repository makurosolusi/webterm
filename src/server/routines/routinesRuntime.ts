// Process-wide routines: store + runner + scheduler over the active ledger, real deps wired here.
// `ensureRoutines()` is idempotent; boot calls it once the ledger is up, and the HTTP route calls it
// too so the panel works even before that.
import { execFile, spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { binaryOnPath } from '../binaryOnPath'
import { lookupWorkspace } from '../central/workspaceLookup'
import { beginCostRunLive, costGateLive, endCostRunLive } from '../cost/costRuntime'
import { eventBus } from '../events/eventBus'
import { recordEvent } from '../events/producers'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'
import { startOutbox } from '../outbox/outboxRuntime'
import { spawnAgent } from '../spawn/agentSpawn'
import { pollPrReviews } from '../prreview/prreview.runtime'
import { runPrecheck } from './routinePrecheck'
import { createRoutineRunner, type KeepAwake, type RoutineRunner } from './routineRunner'
import { createRoutineScheduler, type RoutineScheduler } from './routineScheduler'
import { createRoutineStore, type RoutineStore } from './routineStore'

const log = createLogger('routines')

/** `caffeinate -i -w <pid>` on macOS while any run is active (dies with the server). No-op elsewhere. */
export function createKeepAwake(start: () => ChildProcess | null = defaultCaffeinate): KeepAwake {
  let active = 0
  let proc: ChildProcess | null = null
  return {
    acquire() {
      active += 1
      if (active === 1) proc = start()
    },
    release() {
      active = Math.max(0, active - 1)
      if (active === 0 && proc) { proc.kill(); proc = null }
    },
  }
}

function defaultCaffeinate(): ChildProcess | null {
  if (process.platform !== 'darwin' || !binaryOnPath('caffeinate')) return null
  const proc = spawnProcess('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
  proc.on('error', (err) => log.warn('routines.caffeinate', 'caffeinate failed; the machine may sleep during a run', { error: err.message }))
  return proc
}

/** Workspace cwd; no workspace = the home directory. */
function cwdOf(workspaceId: string | null): string | null {
  if (!workspaceId) return homedir()
  return lookupWorkspace(workspaceId)?.cwd ?? null
}

async function enqueue(input: { to: string; body: string; operationId: string; createdBy: string }): Promise<string | null> {
  const outbox = await startOutbox()
  const refusal = outbox.refusal(input.to)
  if (refusal) return refusal
  outbox.enqueue({ ...input, kind: 'visible' })
  return null
}

const TREE_STATE_TIMEOUT_MS = 10_000

/** HEAD + porcelain status of a checkout; null when `cwd` is not a git work tree (or git fails). */
export function gitTreeState(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'], { timeout: TREE_STATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // Not a repo is the normal case for a home-dir routine: it only means "no diff signal" (counts as no diff).
      resolve(err ? null : String(stdout))
    })
  })
}

export interface RoutinesRuntime { store: RoutineStore; runner: RoutineRunner; scheduler: RoutineScheduler }

let active: { db: unknown; runtime: RoutinesRuntime } | null = null

/** Started runtime over the active ledger, or null when the ledger is off. */
export function ensureRoutines(): RoutinesRuntime | null {
  const ledger = activeLedgerRuntime()
  if (!ledger) return null
  if (active?.db === ledger.db) return active.runtime
  active?.runtime.scheduler.stop()
  const ctx = { db: ledger.db, now: Date.now }
  const store = createRoutineStore(ctx)
  const runner = createRoutineRunner({
    ctx, store, cwdOf, enqueue, record: recordEvent, keepAwake: createKeepAwake(),
    spawn: (req) => spawnAgent(req),
    precheck: runPrecheck,
    cost: { gate: costGateLive, begin: beginCostRunLive, end: endCostRunLive },
    treeState: gitTreeState,
    prReview: pollPrReviews,
  })
  const scheduler = createRoutineScheduler({ store, runner, bus: eventBus, now: Date.now })
  scheduler.start()
  active = { db: ledger.db, runtime: { store, runner, scheduler } }
  return active.runtime
}

/** Test hook. */
export function resetRoutinesForTest(): void {
  active?.runtime.scheduler.stop()
  active = null
}
