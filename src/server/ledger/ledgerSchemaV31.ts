/**
 * v31: `policy_grant.workspace_id`, so a rule can be limited to the agents of one workspace (Settings › Rules &
 * secrets: a secret's "Allow" is for the workspace the user is in, not every agent anywhere). Nullable and NULL
 * means every workspace, so every existing rule keeps matching exactly as before: nothing to backfill.
 * Idempotent: the ALTER is guarded (ADD COLUMN has no IF NOT EXISTS).
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV31(db: Database): void {
  addColumnIfMissing(db, 'policy_grant', 'workspace_id', 'TEXT')
}
