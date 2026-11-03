// task.status and run.result (R0): ledger task/run state of one project. Rows are always scoped by
// project id, so a task or run of another project reads as not found. Text fields are clipped here;
// the loop redacts and clips again before anything reaches the model.
import type { Database } from 'bun:sqlite'
import { allRows, getRow, type Row } from '../../../ledger/ledgerCore'
import type { ToolDef, ToolResult } from '../toolTypes'
import { clip, isSafeId, READ_TOOLS_FLAG } from './read.shared'

const SPEC_PREVIEW = 200
const EVIDENCE_PREVIEW = 1500
const RECENT_TASKS = 10

function text(value: unknown): string | null { return value === null || value === undefined ? null : String(value) }

function taskRow(r: Row, detail: boolean): Record<string, unknown> {
  return {
    id: String(r['id']), status: String(r['status']), attempt: Number(r['attempt']), maxAttempts: Number(r['max_attempts']),
    agentId: text(r['agent_id']), spec: clip(String(r['spec']), SPEC_PREVIEW), updatedAt: Number(r['updated_at']),
    ...(detail ? { leaseExpires: r['lease_expires'] ?? null, evidence: clip(text(r['evidence_json']) ?? 'null', EVIDENCE_PREVIEW) } : {}),
  }
}

function taskExists(db: Database, projectId: unknown, taskId: unknown): boolean {
  return getRow(db, 'SELECT 1 AS one FROM task WHERE id = ? AND project_id = ?', taskId, projectId) !== null
}

const taskStatus: ToolDef = {
  name: 'task.status',
  summary: 'Task status of a project: counts and the latest tasks, or one task by id.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  usage: '{"projectId":"<id>","taskId":"<optional task id>"}. Read-only; without taskId returns counts and the 10 latest tasks.',
  validate(input, ctx) {
    if (input.taskId === undefined) return null
    if (!isSafeId(input.taskId)) return 'invalid_shape'
    return taskExists(ctx.db, input.projectId, input.taskId) ? null : 'task_not_found'
  },
  handler(ctx, input, projectId): ToolResult {
    if (typeof input.taskId === 'string') {
      const row = getRow(ctx.db, 'SELECT * FROM task WHERE id = ? AND project_id = ?', input.taskId, projectId)
      return row ? { ok: true, data: { task: taskRow(row, true) } } : { ok: false, code: 'task_not_found' }
    }
    const counts: Record<string, number> = {}
    for (const r of allRows(ctx.db, 'SELECT status, COUNT(*) AS n FROM task WHERE project_id = ? GROUP BY status', projectId)) {
      counts[String(r['status'])] = Number(r['n'])
    }
    const recent = allRows(ctx.db, 'SELECT * FROM task WHERE project_id = ? ORDER BY updated_at DESC, id ASC LIMIT ?', projectId, RECENT_TASKS)
    return { ok: true, data: { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), recent: recent.map((r) => taskRow(r, false)) } }
  },
}

const runResult: ToolDef = {
  name: 'run.result',
  summary: 'Outcome of a run: the latest run of a task, or one run by id.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  usage: '{"projectId":"<id>","taskId":"<task id>"} or {"projectId":"<id>","runId":"<run id>"}. Read-only; outcome, failure label and evidence head.',
  validate(input, ctx) {
    const { taskId, runId } = input
    if ((taskId === undefined) === (runId === undefined)) return 'invalid_shape'
    if (!isSafeId(taskId ?? runId)) return 'invalid_shape'
    return taskId !== undefined && !taskExists(ctx.db, input.projectId, taskId) ? 'task_not_found' : null
  },
  handler(ctx, input, projectId): ToolResult {
    const row = typeof input.runId === 'string'
      ? getRow(ctx.db, 'SELECT * FROM run WHERE id = ? AND project_id = ?', input.runId, projectId)
      : getRow(ctx.db, 'SELECT * FROM run WHERE task_id = ? AND project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', input.taskId, projectId)
    if (!row) return { ok: false, code: 'run_not_found' }
    return {
      ok: true,
      data: {
        runId: String(row['id']), taskId: text(row['task_id']), outcome: text(row['outcome']), failureLabel: text(row['failure_label']),
        provider: text(row['provider']), model: text(row['model']), startedAt: Number(row['started_at']), endedAt: row['ended_at'] ?? null,
        evidence: clip(text(row['evidence_json']) ?? 'null', EVIDENCE_PREVIEW),
      },
    }
  },
}

/** R0 task and run read tools. */
export const TASK_READ_DEFS: readonly ToolDef[] = [taskStatus, runResult]
