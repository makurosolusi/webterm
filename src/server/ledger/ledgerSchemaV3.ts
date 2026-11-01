/**
 * P3 idempotency journal (v3). Approval mutation acks live in the ledger file so a replay of the
 * same requestId after a restart returns the original response instead of creating a second
 * approval/decision/consume. `response_json` is JSON because the response shape differs per route.
 */
export const DDL_V3 = `
CREATE TABLE IF NOT EXISTS request_ack (
  key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_ack_expires ON request_ack(expires_at);
`
