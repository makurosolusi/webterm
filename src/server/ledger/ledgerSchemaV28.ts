/**
 * v28: links board tasks to the plan that produced them.
 *
 * A project has one goal, stored as a versioned document in `project.goal_json`, so project + version is the
 * link and there is no goal table to reference. `seq` keeps the order Central planned the tasks in, which
 * `updated_at` cannot once work starts. Both nullable: tasks made outside a plan stay unlinked, nothing to
 * backfill. Idempotent: guarded ALTERs and IF NOT EXISTS.
 */
import type { Database } from 'bun:sqlite'
import { addColumnIfMissing } from './ledgerSchemaAlter'

export function applyV28(db: Database): void {
  addColumnIfMissing(db, 'central_task', 'goal_version', 'INTEGER')
  addColumnIfMissing(db, 'central_task', 'seq', 'INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS idx_central_task_goal ON central_task(project_id, goal_version)')
}
