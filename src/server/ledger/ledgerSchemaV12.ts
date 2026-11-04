/**
 * v12 `agent_outbox` (PLAN/02-fase.md F2-d, PLAN/01-arsitektur.md K2): the persistent per-node outbox
 * in `src/server/outbox/`. One row per message addressed to an agent node; it survives a restart, so
 * a message queued while the agent was busy is still delivered at its next idle edge.
 *
 * - `operation_id UNIQUE` is the exactly-once contract: a retried enqueue with the same id returns
 *   the first row instead of a second message (Orca `operationId` + `--retry-launch`).
 * - `status`: queued -> delivered | failed | cancelled (a superseded link note).
 * - `body` is the message text; it is NEVER copied into the Senses event payload (Rule 12).
 *
 * Additive only (CREATE ... IF NOT EXISTS): re-running after a partial apply is safe and no existing
 * table changes, so no backfill is needed.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V12 = `
CREATE TABLE IF NOT EXISTS agent_outbox (
  id            TEXT PRIMARY KEY,
  operation_id  TEXT NOT NULL UNIQUE,
  to_node       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('visible','context')),
  body          TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','failed','cancelled')),
  transport     TEXT CHECK (transport IS NULL OR transport IN ('channel','hook','pty')),
  error         TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  settled_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_outbox_node ON agent_outbox(to_node, status, priority DESC, created_at);
`

export function applyV12(db: Database): void {
  db.exec(DDL_V12)
}
