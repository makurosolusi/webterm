/**
 * v38: `cost_usage.tier` (the model-ladder tier a worker response was billed under).
 *
 * Why: worker cost is captured from the transcript with the real model id, but the tier lives only on the
 * agent row (`central_agents.budget_json` -> `ladder.pick.tier`). Without it on the cost row, tuning the
 * ladder thresholds from spend by kind x tier cannot be done. Nullable: rows of non-worker sources and of
 * nodes with no Central agent stay NULL; a worker row whose agent has no ladder pick reads 'unknown'.
 * Backfill: existing agent rows take the tier of the newest agent that started on the node at or before
 * the response (same rule as capture), run once, only when the column was just added.
 * Idempotent: the column is added only when missing, so a second run changes nothing.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV38(db: Database): void {
  if (!addColumnIfMissing(db, 'cost_usage', 'tier', 'TEXT')) return
  db.exec(`UPDATE cost_usage SET tier = (
      SELECT COALESCE(json_extract(a.budget_json, '$.ladder.pick.tier'), 'unknown') FROM central_agents a
      WHERE a.node_id = cost_usage.node_id AND a.started_at <= cost_usage.ts ORDER BY a.started_at DESC LIMIT 1)
    WHERE source = 'agent' AND node_id IS NOT NULL`)
}
