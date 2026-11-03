/**
 * CA2 v5 `ca2_safety` (RND/29-CA2-ARSITEKTUR-b.md 4.6): kill-switch level per scope, circuit
 * breakers, and the daily budget counters. Additive and idempotent; no cross-table FKs so the
 * ledger still opens standalone (same rule as v4). `central_control.version` is the CAS token.
 */
export const DDL_V5 = `
CREATE TABLE IF NOT EXISTS central_control (
  scope TEXT PRIMARY KEY CHECK (scope = 'global' OR scope LIKE 'project:%'),
  level TEXT NOT NULL DEFAULT 'off' CHECK (level IN ('off','observe','propose','act_gated','act_envelope')),
  reason TEXT, set_by TEXT NOT NULL, set_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS central_breaker (
  key TEXT PRIMARY KEY CHECK (key LIKE 'project:%' OR key LIKE 'provider:%' OR key LIKE 'item:%'),
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  opened_at INTEGER, retry_at INTEGER, last_code TEXT
);

-- day = UTC 'YYYY-MM-DD'; scope = 'global' or 'project:<id>'.
CREATE TABLE IF NOT EXISTS central_budget (
  day TEXT NOT NULL, scope TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0, spawns INTEGER NOT NULL DEFAULT 0,
  wall_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);
`
