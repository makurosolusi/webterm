// Production wiring of the bake-off service: the process-wide `agent.spawn`, the F4-c verifier over the
// project's own scripts, and worktrees under `<dataDir>/worktrees`. One service per active ledger,
// built on the first request (zero-config); orphaned candidates are failed when it is built.
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { spawnAgent } from '../spawn/agentSpawn'
import { verifyWorktreeCompletion } from '../verifier/verifier.checks'
import { createBakeoffService, type BakeoffService } from './bakeoff.service'

let shared: { db: unknown; service: BakeoffService } | null = null

/** The bake-off service over the active ledger; null when the ledger is off. */
export function bakeoffService(): BakeoffService | null {
  const rt = activeLedgerRuntime()
  if (!rt) return null
  if (shared?.db !== rt.db) {
    const service = createBakeoffService({ ctx: { db: rt.db, now: Date.now }, spawn: (req) => spawnAgent(req), verify: verifyWorktreeCompletion })
    service.recover()
    shared = { db: rt.db, service }
  }
  return shared.service
}
