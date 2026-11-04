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
import { applyV12 } from './ledgerSchemaV12'
import { applyV13 } from './ledgerSchemaV13'
import { applyV14 } from './ledgerSchemaV14'
import { applyV15 } from './ledgerSchemaV15'
import { applyV16 } from './ledgerSchemaV16'
import { applyV17 } from './ledgerSchemaV17'
import { applyV18 } from './ledgerSchemaV18'

/** One forward-only schema step; `up` runs inside BEGIN IMMEDIATE. */
export interface Migration {
  version: number
  up(db: Database): void
}

/**
 * Ordered forward-only migrations. The DDL lives in `ledgerSchemaV{1..17}.ts`
 * (base ledger, plan, request journal, central agent, CA2 safety/agents/memory/checkpoint/audit, Senses event log, policy grants, agent outbox, channel store, inbox items, routines, task DAG, cost oracle); never renumber or reorder an entry.
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
  // v12: agent outbox (F2-d); additive table, nothing to backfill.
  { version: 12, up: applyV12 },
  // v13: channel store document (F2-g); additive table, channels.json is imported lazily at channel start.
  { version: 13, up: applyV13 },
  // v14: inbox items (F3-a); additive table, pending approvals are mirrored lazily at the first read.
  { version: 14, up: applyV14 },
  // v15: routines + run history (F4-a); additive tables, nothing to backfill.
  { version: 15, up: applyV15 },
  // v16: task DAG (F4-b); additive tables. v15 is taken by the routines WP in parallel.
  { version: 16, up: applyV16 },
  // v17: cost oracle tables + routine_run.estimate_usd, until now created by their modules; IF NOT EXISTS keeps their rows.
  { version: 17, up: applyV17 },
  // v18: memory intelligence (F5-a): bi-temporal columns, cognitive kind, tombstones, incognito.
  { version: 18, up: applyV18 },
]
