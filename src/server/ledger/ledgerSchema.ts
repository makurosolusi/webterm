import type { Database } from 'bun:sqlite'
import { DDL_V1 } from './ledgerSchemaV1'
import { DDL_V2 } from './ledgerSchemaV2'
import { DDL_V3 } from './ledgerSchemaV3'

/** One forward-only schema step; `up` runs inside BEGIN IMMEDIATE. */
export interface Migration {
  version: number
  up(db: Database): void
}

/**
 * Ordered forward-only migrations. The DDL lives in `ledgerSchemaV{1,2,3}.ts`
 * (base ledger, plan, request journal); never renumber or reorder an entry.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(DDL_V1) },
  { version: 2, up: (db) => db.exec(DDL_V2) },
  { version: 3, up: (db) => db.exec(DDL_V3) },
]
