// The ladder tier a worker's cost row is booked under, read from the Central agent that owned the node then.
import type { Database } from 'bun:sqlite'
import { getRow } from '../ledger/ledgerCore'
import { storedPick } from '../central/agents/agentLadder'

/** Tier of the newest agent that started on `nodeId` at or before `ts`; 'unknown' = agent without a stored pick, null = no agent. */
export function workerTier(db: Database, nodeId: string, ts: number): string | null {
  const agent = getRow(db, 'SELECT budget_json FROM central_agents WHERE node_id = ? AND started_at <= ? ORDER BY started_at DESC LIMIT 1', nodeId, ts)
  if (!agent) return null
  return storedPick({ budgetJson: agent['budget_json'] == null ? null : String(agent['budget_json']) })?.tier ?? 'unknown'
}
