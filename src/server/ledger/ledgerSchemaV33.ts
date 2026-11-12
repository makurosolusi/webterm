/**
 * v33: `central_control` also holds named settings (`setting:<name>` rows with `value_json`).
 *
 * Why: some switches must outlive event retention. The classifier switch used to live only in the event log, so
 * after 30 days its row was pruned and auto-approval silently turned off; the boot notice also needs to remember
 * which defaults it already announced. `central_control` is configuration and exempt from pruning.
 * SQLite cannot ALTER a CHECK, so the table is rebuilt once (rows kept); `level` keeps its default for setting rows.
 * Idempotent: the rebuild only runs while the stored DDL lacks 'setting:%'.
 */
import type { Database } from 'bun:sqlite'

const CENTRAL_CONTROL_V33 = `
CREATE TABLE central_control_v33 (
  scope TEXT PRIMARY KEY CHECK (scope = 'global' OR scope LIKE 'project:%' OR scope LIKE 'setting:%'),
  level TEXT NOT NULL DEFAULT 'off' CHECK (level IN ('off','observe','propose','act_gated','act_envelope')),
  reason TEXT, set_by TEXT NOT NULL, set_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  value_json TEXT
);
INSERT INTO central_control_v33 (scope, level, reason, set_by, set_at, version)
  SELECT scope, level, reason, set_by, set_at, version FROM central_control;
DROP TABLE central_control;
ALTER TABLE central_control_v33 RENAME TO central_control;
`

export function applyV33(db: Database): void {
  const ddl = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'central_control'").get() as { sql?: string } | null)?.sql ?? ''
  if (!ddl.includes("'setting:%'")) db.exec(CENTRAL_CONTROL_V33)
}
