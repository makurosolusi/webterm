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
import { applyV19 } from './ledgerSchemaV19'
import { applyV20 } from './ledgerSchemaV20'
import { applyV21 } from './ledgerSchemaV21'
import { applyV22 } from './ledgerSchemaV22'
import { applyV23 } from './ledgerSchemaV23'
import { applyV24 } from './ledgerSchemaV24'
import { applyV25 } from './ledgerSchemaV25'
import { applyV26 } from './ledgerSchemaV26'
import { applyV27 } from './ledgerSchemaV27'
import { applyV28 } from './ledgerSchemaV28'
import { applyV29 } from './ledgerSchemaV29'
import { applyV30 } from './ledgerSchemaV30'
import { applyV31 } from './ledgerSchemaV31'
import { applyV32 } from './ledgerSchemaV32'
import { applyV33 } from './ledgerSchemaV33'
import { applyV34 } from './ledgerSchemaV34'
import { applyV35 } from './ledgerSchemaV35'

/** One forward-only schema step; `up` runs inside BEGIN IMMEDIATE. */
export interface Migration {
  version: number
  up(db: Database): void
}

/**
 * Ordered forward-only migrations. The DDL lives in `ledgerSchemaV{1..19}.ts`
 * (base ledger, plan, request journal, central agent, CA2 safety/agents/memory/checkpoint/audit, Senses event log, policy grants, agent outbox, channel store, inbox items, routines, task DAG, cost oracle, memory intelligence, caches); never renumber or reorder an entry.
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
  // v19: tool_cache + embed_cache + prefix.last_used_at (F5-d); additive, caches start empty.
  { version: 19, up: applyV19 },
  // v20: bake-off runs + candidates (F6); additive tables, nothing to backfill.
  { version: 20, up: applyV20 },
  // v21: eval_case (F6 eval harness from user rejections); additive.
  { version: 21, up: applyV21 },
  // v22: event(ts)/event(node_id, ts) indexes for replay; cost_run rebuilt once so kind admits 'bakeoff'.
  { version: 22, up: applyV22 },
  // v23: retention — event chain base (prefix prune keeps the chain verifiable) + settle-time indexes; no backfill.
  { version: 23, up: applyV23 },
  // v24: cost_run.tier + cost_run.model (model ladder); nullable, no backfill.
  { version: 24, up: applyV24 },
  // v25: central work tables (task, deps, assignment) + event(correlation_id); additive, nothing to backfill.
  { version: 25, up: applyV25 },
  // v26: project.work_auto_done (per-project auto-done switch); default off, nothing to backfill.
  { version: 26, up: applyV26 },
  // v27: central_state (pinned STATE) + central_turn.context_json (per-turn trace); additive, nothing to backfill.
  { version: 27, up: applyV27 },
  // v28: central_task.goal_version + seq (Goal -> Plan -> Task chain); nullable, no backfill.
  { version: 28, up: applyV28 },
  // v29: central_reminder + central_checkin_reason + central_turn.origin (self-started turns); additive, old turns are 'user'.
  { version: 29, up: applyV29 },
  // v30: central_finding + central_health_scan (project health advice with evidence); additive, nothing to backfill.
  { version: 30, up: applyV30 },
  // v31: policy_grant.workspace_id (rule limited to one workspace); nullable, NULL = every workspace, no backfill.
  { version: 31, up: applyV31 },
  // v32: central_checkin_reason.not_before (a failed delegation waits for the turn that saw it); nullable, no backfill.
  { version: 32, up: applyV32 },
  // v33: central_control admits `setting:<name>` rows with value_json (switches that must outlive event retention); rows kept.
  { version: 33, up: applyV33 },
  // v34: central_playbook_run (cursor of a playbook waiting on an approval); additive, nothing to backfill.
  { version: 34, up: applyV34 },
  // v35: central_checkin_reason.conversation_id (check-ins return to the conversation that asked); nullable, unsent reasons backfilled from their task.
  { version: 35, up: applyV35 },
]
