import type { Database } from 'bun:sqlite'
import { DDL_V1 } from './ledgerSchemaV1'
import { DDL_V2 } from './ledgerSchemaV2'
import { DDL_V3 } from './ledgerSchemaV3'
import { applyV4 } from './ledgerSchemaV4'
import { DDL_V5 } from './ledgerSchemaV5'
import { DDL_V6 } from './ledgerSchemaV6'
import { applyV7 } from './ledgerSchemaV7'
import { applyV8 } from './ledgerSchemaV8'
import { applyV9 } from './ledgerSchemaV9'
import { applyV10 } from './ledgerSchemaV10'
import { applyV11 } from './ledgerSchemaV11'

/** One forward-only schema step; `up` runs inside BEGIN IMMEDIATE. */
export interface Migration {
  version: number
  up(db: Database): void
}

/**
 * Ordered forward-only migrations. The DDL lives in `ledgerSchemaV{1..11}.ts`
 * (base ledger, plan, request journal, central agent, CA2 safety/agents/memory/checkpoint/audit, Senses event log, policy grants); never renumber or reorder an entry.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(DDL_V1) },
  { version: 2, up: (db) => db.exec(DDL_V2) },
  { version: 3, up: (db) => db.exec(DDL_V3) },
  // v4 also adds `project.goal_json`; applyV4 guards the ALTER so a re-run is safe.
  { version: 4, up: applyV4 },
  // v5-v9 (CA2): additive; V7-V9 use guarded ALTERs. V9 omits the append-only trigger (see ledgerSchemaV9.ts).
  { version: 5, up: (db) => db.exec(DDL_V5) },
  { version: 6, up: (db) => db.exec(DDL_V6) },
  { version: 7, up: applyV7 },
  { version: 8, up: applyV8 },
  { version: 9, up: applyV9 },
  // v10: Senses event columns + append-only triggers on chained rows (closes TODO(ca2-audit)).
  { version: 10, up: applyV10 },
  // v11: policy principals/grants/tier minima/tokens (S2); additive, builtin rows reproduce pre-v11 behaviour.
  { version: 11, up: applyV11 },
]
