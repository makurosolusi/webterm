// Production wiring of the DAG scheduler (F4-b): real git worktrees, `agent.spawn` headless Claude Code
// workers, the F4-c verifier, inbox gate cards and the Senses event log. Zero-config: the scheduler
// arms itself on the first DAG route call (and survives restarts as rows), polls every 2 s like Orca
// (`coordinator.ts:31`) while an active dag exists, and stops polling when none is left.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { dataDir } from '../config'
import { beginCostRunLive, costGateLive, endCostRunLive } from '../cost/costRuntime'
import { recordEvent } from '../events/producers'
import { isEnabled } from '../featureCapabilities.runtime'
import { createGate } from '../inbox/inboxItemStore'
import type { LedgerContext } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { verifyWorktree } from '../orchestrator/verify'
import { createProcessExec } from '../orchestrator/verifier'
import { spawnAgent } from '../spawn/agentSpawn'
import { projectChecks } from '../verifier/verifier.checks'
import { judgeCompletion } from '../verifier/verifier.judge'
import { recordCompletion } from '../verifier/verifier.report'
import { createDagScheduler, type DagPorts, type DagScheduler, type VerifyTaskInput } from './dag.scheduler'

const log = createLogger('dag')
export const DAG_TICK_MS = 2000
const GIT_TIMEOUT_MS = 60_000
const GATE_TTL_MS = 24 * 60 * 60_000

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} in ${cwd} failed: ${String(stderr || err.message).trim().slice(0, 300)}`, { cause: err }))
      else resolve(String(stdout).trim())
    })
  })
}

async function verifyTask(input: VerifyTaskInput) {
  const checks = projectChecks(input.cwd)
  const verdict = await verifyWorktree(
    { root: input.cwd, exec: createProcessExec(), timeoutMs: input.timeoutMs, commands: { test: input.verifyCmd } },
    { cwd: input.cwd, scope: input.lease, baseRef: input.baseRef, checks: { test: true, typecheck: checks?.typecheck ?? false, lint: false } },
  )
  return judgeCompletion({ taskId: input.taskId, verdict, ...(input.claim !== undefined ? { claim: input.claim } : {}) })
}

export function productionDagPorts(ctx: LedgerContext): DagPorts {
  return {
    ctx,
    record: recordEvent,
    workersEnabled: () => isEnabled('workers'),
    async behind(dag) {
      if (!dag.baseBranch) return null
      try {
        return Number(await git(dag.repo, ['rev-list', '--count', `${dag.baseRef}..${dag.baseBranch}`]))
      } catch {
        return null // no such branch / not a repo: the guard is inert, as Orca's is without a selector
      }
    },
    async allocate(dag, task, dispatchId) {
      const baseSha = await git(dag.repo, ['rev-parse', '--verify', `${dag.baseRef}^{commit}`])
      const branch = `dag/${dag.id.slice(0, 8)}/${task.key}-${dispatchId.slice(0, 6)}`
      const path = join(dataDir(), 'dag-worktrees', dispatchId)
      await git(dag.repo, ['worktree', 'add', '-b', branch, path, baseSha])
      return { path, branch, baseSha }
    },
    spawn: (req) => spawnAgent(req),
    cost: { gate: costGateLive, begin: beginCostRunLive, end: endCostRunLive },
    verify: verifyTask,
    report: (r) => recordCompletion(r, () => ctx),
    openGate: (g) => createGate(ctx, {
      projectId: g.projectId, source: 'dag', title: g.title, body: g.options ? `${g.body}\nOptions: ${g.options.join(' | ')}` : g.body,
      args: { options: g.options }, impact: { what: 'Unblocks a DAG task waiting on your decision', tier: 'R1', rewindable: true },
      nodeId: g.nodeId, ttlMs: GATE_TTL_MS,
    }).approvalId!,
  }
}

let shared: { db: unknown; scheduler: DagScheduler; timer: ReturnType<typeof setInterval> | null } | null = null

/** The process scheduler over the active ledger; null when the ledger is off. */
export function dagScheduler(): DagScheduler | null {
  const rt = activeLedgerRuntime()
  if (!rt) return null
  if (shared?.db !== rt.db) {
    if (shared?.timer) clearInterval(shared.timer)
    const scheduler = createDagScheduler(productionDagPorts({ db: rt.db, now: Date.now }))
    scheduler.recoverOrphans()
    shared = { db: rt.db, scheduler, timer: null }
  }
  return shared.scheduler
}

/** Starts the 2 s poll while an active dag exists. Idempotent. */
export function armDagLoop(): void {
  const s = dagScheduler()
  if (!s || !shared || shared.timer) return
  const state = shared
  state.timer = setInterval(() => {
    if (s.store.active().length === 0) {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      return
    }
    s.tick().catch((err: unknown) => log.error('dag.tick.failed', 'dag scheduler tick failed', { cause: err instanceof Error ? err.message : String(err) }))
  }, DAG_TICK_MS)
  ;(state.timer as unknown as { unref?: () => void }).unref?.()
}
