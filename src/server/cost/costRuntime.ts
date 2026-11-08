// Process wiring for cost capture and the entry points routines / the DAG call. Everything reads
// the active ledger per call; ledger off = no capture and an always-open gate (nothing to measure).
import type { Database } from 'bun:sqlite'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { eventBus } from '../events/eventBus'
import { createLogger } from '../logs'
import { captureTranscript, syncCentralTurns } from './costCapture'
import { warnDailyCost } from './costDailyWarning'
import { beginCostRun, costGate, endCostRun, type BeginRunInput, type CostRunKind, type EndRunResult, type GateResult } from './costOracle'

const log = createLogger('cost')
/** Claude Code hooks after which a transcript has new billed responses. */
const CAPTURE_HOOKS = new Set(['hook.Stop', 'hook.SubagentStop', 'hook.SessionEnd', 'hook.PreCompact'])
const CENTRAL_SYNC_MS = 60_000

export interface CostRuntimeDeps {
  db: () => Database | null
  /** Transcript path last reported by a node's hooks. */
  transcriptOf: (nodeId: string) => string | undefined
}

let deps: CostRuntimeDeps | null = null
let stop: (() => void) | null = null

async function defaultDeps(): Promise<CostRuntimeDeps> {
  const { sessions } = await import('../sessions')
  return { db: () => activeLedgerRuntime()?.db ?? null, transcriptOf: (id) => sessions.getTranscript(id) }
}

/** Reads what is new in one node's transcripts. Never throws: a broken file must not break a hook. */
export function captureNode(nodeId: string, workspaceId: string | null): number {
  const db = deps?.db()
  const path = deps?.transcriptOf(nodeId)
  if (!db || !path) return 0
  try {
    return captureTranscript(db, { path, nodeId, workspaceId })
  } catch (err) {
    log.warn('cost.capture_failed', 'Cannot read agent transcript usage', { ids: { nodeId }, error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}

/** Pulls finished Central turns into the cost table (and the guard's daily budget). */
export function syncCentral(): number {
  const db = deps?.db()
  if (!db) return 0
  try {
    const added = syncCentralTurns(db)
    warnDailyCost(db)
    return added
  } catch (err) {
    log.warn('cost.central_sync_failed', 'Cannot sync Central turn usage', { error: err instanceof Error ? err.message : String(err) })
    return 0
  }
}

/** Idempotent boot: hook subscription + a Central sync timer. Tests pass their own deps. */
export async function startCostCapture(custom?: CostRuntimeDeps): Promise<void> {
  if (stop) return
  deps = custom ?? (await defaultDeps())
  if (stop) return
  const off = eventBus.subscribe('hook.*', (e) => { if (e.nodeId && CAPTURE_HOOKS.has(e.kind)) captureNode(e.nodeId, e.workspaceId ?? null) })
  const timer = setInterval(syncCentral, CENTRAL_SYNC_MS)
  timer.unref?.()
  stop = () => { off(); clearInterval(timer); stop = null; deps = null }
  syncCentral()
}

export function stopCostCapture(): void { stop?.() }

// ---- Entry points for routines and the task DAG (they own scheduling; this owns cost). ----

/** Before a run: `{ allowed:false }` = do not start it (paused, or a cap is used up); `estimate` is for the plan. */
export async function costGateLive(q: { kind: CostRunKind; ref: string; workspaceId?: string | null }): Promise<GateResult> {
  await startCostCapture()
  syncCentral()
  const db = deps?.db()
  return db ? costGate(db, q) : { allowed: true, reason: null, estimate: { medianMicros: null, samples: 0, basis: 'none' } }
}

/** When the run hands work to its node; returns the run id for `endCostRunLive`, or null with the ledger off. */
export async function beginCostRunLive(input: BeginRunInput): Promise<string | null> {
  await startCostCapture()
  const db = deps?.db()
  if (!db) return null
  if (input.nodeId) captureNode(input.nodeId, input.workspaceId ?? null)
  return beginCostRun(db, input)
}

/** When the run is done. `producedDiff:false` runs count toward the low-ROI pause. */
export async function endCostRunLive(id: string | null, outcome: { producedDiff?: boolean }): Promise<EndRunResult | null> {
  const db = deps?.db()
  if (!id || !db) return null
  const run = db.query('SELECT node_id, workspace_id FROM cost_run WHERE id = ?').get(id) as { node_id: string | null; workspace_id: string | null } | null
  if (run?.node_id) captureNode(run.node_id, run.workspace_id)
  return endCostRun(db, id, outcome)
}
