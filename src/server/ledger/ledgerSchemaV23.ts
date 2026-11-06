/**
 * v23: retention for the ledger (data-209-1, data-209-10, agent-211-C4).
 *
 * Why: the Senses `event` chain was append-only with no end (v10 `event_chain_no_delete`), so
 * ledger.db grew by ~566 B per hook event forever, and settled outbox/inbox/approval/dag rows had
 * no lifecycle end either. Retention (ledgerRetention.ts) now drops old rows in bounded batches.
 *
 * - `event_chain_base`: the chain's new origin after a prefix prune — the {seq, hash} of the last
 *   dropped chained row. verifyChain starts from it instead of GENESIS_HASH, so the remaining chain
 *   stays verifiable. No row = nothing pruned = genesis, so existing DBs need no backfill.
 * - `event_chain_no_delete` is recreated to allow deleting chained rows at or below that base only;
 *   every row above it is still append-only. The update/insert triggers of v10 are unchanged.
 * - Indexes for the retention predicates (status + settle time) and for the "still referenced?"
 *   checks on approvals/decisions, so a sweep never scans a table.
 *
 * Idempotent: CREATE ... IF NOT EXISTS; the trigger is dropped (IF EXISTS) and recreated.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V23 = `
CREATE TABLE IF NOT EXISTS event_chain_base (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  pruned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

DROP TRIGGER IF EXISTS event_chain_no_delete;
CREATE TRIGGER IF NOT EXISTS event_chain_no_delete BEFORE DELETE ON event
WHEN OLD.hash IS NOT NULL AND OLD.seq > COALESCE((SELECT seq FROM event_chain_base WHERE id = 1), 0)
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE INDEX IF NOT EXISTS idx_agent_outbox_settled ON agent_outbox(status, settled_at);
CREATE INDEX IF NOT EXISTS idx_inbox_item_resolved ON inbox_item(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_approval_status_updated ON approval(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_dag_status_updated ON dag(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_central_event_created ON central_event(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_mail_expires ON agent_mail(expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_decision ON approval(decision_id);
CREATE INDEX IF NOT EXISTS idx_dag_gate_approval ON dag_gate(approval_id);
CREATE INDEX IF NOT EXISTS idx_central_agents_approval ON central_agents(approval_id);
`

export function applyV23(db: Database): void {
  db.exec(DDL_V23)
}
