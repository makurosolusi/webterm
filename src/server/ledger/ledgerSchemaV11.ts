/**
 * v11 `policy_principals_grants` (PLAN/01-arsitektur.md S2, K3, K4): the persisted half of the policy
 * model in `src/server/policy/`. Cable grants are NOT stored here: they are computed live from the
 * board's edges on every check, so they can never drift from what the canvas shows.
 *
 * - `policy_grant`: one allow/ask/deny rule, evaluated last-match-wins (OpenCode permissions). The
 *   seeded `builtin` rows reproduce the pre-v11 behaviour (human-ui and central allowed, the guard's
 *   level ladder still decides; nodes deny by default; telegram asks) and stay editable as data.
 * - `policy_tier_min`: the minimum control level per risk tier, previously the `MIN_LEVEL` constant
 *   in `central/guard/controlGuard.ts`. Seeded with the same values, so nothing changes until a human
 *   edits a row.
 * - `policy_principal`: parent links for spawned nodes, so a child's decision is attenuated to at most
 *   its parent's (K3).
 * - `policy_token`: sha256 of each issued principal token, so tokens survive a restart (gap 01 §6.9);
 *   the raw token is never stored.
 *
 * Additive only (CREATE ... IF NOT EXISTS, INSERT OR IGNORE): re-running after a partial apply is safe
 * and no existing table changes.
 */
import type { Database } from 'bun:sqlite'

export const DDL_V11 = `
CREATE TABLE IF NOT EXISTS policy_grant (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  capability  TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '*',
  effect      TEXT NOT NULL CHECK (effect IN ('allow','ask','deny')),
  expires_at  INTEGER,
  origin      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ord         INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_policy_grant_live ON policy_grant(revoked_at, ord);

CREATE TABLE IF NOT EXISTS policy_tier_min (
  tier       TEXT PRIMARY KEY CHECK (tier IN ('R0','R1','R2','R3')),
  min_level  TEXT NOT NULL CHECK (min_level IN ('off','observe','propose','act_gated','act_envelope'))
);

CREATE TABLE IF NOT EXISTS policy_principal (
  id          TEXT PRIMARY KEY,
  parent      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_token (
  token_hash  TEXT PRIMARY KEY,
  principal   TEXT NOT NULL,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_policy_token_principal ON policy_token(principal);

INSERT OR IGNORE INTO policy_tier_min (tier, min_level) VALUES
  ('R0','observe'), ('R1','propose'), ('R2','act_gated'), ('R3','propose');

INSERT OR IGNORE INTO policy_grant (id, subject, capability, scope, effect, expires_at, origin, created_by, created_at, ord) VALUES
  ('builtin-human-ui', 'human-ui',     '*', '*', 'allow', NULL, 'builtin', 'migration', 0, 1),
  ('builtin-central',  'central',      '*', '*', 'allow', NULL, 'builtin', 'migration', 0, 2),
  ('builtin-node',     'node:*',       '*', '*', 'deny',  NULL, 'builtin', 'migration', 0, 3),
  ('builtin-telegram', 'telegram:*',   '*', '*', 'ask',   NULL, 'builtin', 'migration', 0, 4),
  ('builtin-routine',  'routine:*',    '*', '*', 'deny',  NULL, 'builtin', 'migration', 0, 5);
`

export function applyV11(db: Database): void {
  db.exec(DDL_V11)
}
