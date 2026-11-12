// Central's reminders: something to check later. A project chat only reaches its own project.
import { obj, S } from '../../../capability/capability.schema'
import { getRow } from '../../../ledger/ledgerCore'
import { scopeFromConversationId } from '../../conversationModel'
import { REMINDER_MAX_MINUTES, REMINDER_MIN_MINUTES, REMINDER_TEXT_MAX, addReminder, cancelReminder, listReminders, reminderDueAt } from '../../work/workReminders'
import type { ToolCtx, ToolDef, ToolInput, ToolResult, ToolValidationCode } from '../toolTypes'
import { MAX_ID, isSafeId, readPage } from './read.shared'

const CREATED_BY = 'central'
const AT_MAX = 40

function ownProject(ctx: ToolCtx): string | undefined {
  const scope = scopeFromConversationId(ctx.conversationId)
  return scope.kind === 'project' ? scope.projectId : undefined
}

function checkSet(input: ToolInput, ctx: ToolCtx): ToolValidationCode | null {
  const { projectId, taskId, text } = input
  if (typeof text !== 'string' || text.trim() === '') return 'invalid_shape'
  if ((projectId !== undefined && !isSafeId(projectId)) || (taskId !== undefined && !isSafeId(taskId))) return 'invalid_shape'
  const own = ownProject(ctx)
  if (own !== undefined && projectId !== undefined && projectId !== own) return 'conversation_project_mismatch'
  const wanted = (projectId as string | undefined) ?? own
  if (wanted !== undefined && !getRow(ctx.db, 'SELECT 1 AS one FROM project WHERE id = ?', wanted)) return 'project_not_found'
  if (taskId === undefined) return null
  const task = getRow(ctx.db, 'SELECT project_id FROM central_task WHERE id = ?', taskId)
  return !task || (wanted !== undefined && task.project_id !== wanted) ? 'task_not_found' : null
}

const set: ToolDef = {
  name: 'reminder.set', summary: 'Check later what only time tells (a user follow-up, an outside wait); never for delegated agents.', tier: 'R1',
  projectScoped: false, auditKeys: ['id', 'dueAt'],
  usage: `{"inMinutes":<${REMINDER_MIN_MINUTES}-${REMINDER_MAX_MINUTES}> or "at":"ISO time up to 90 days ahead","text":"what to check, no secrets","projectId":"optional","taskId":"optional"}`,
  input: obj({ inMinutes: S.int(REMINDER_MIN_MINUTES, REMINDER_MAX_MINUTES), at: S.str(AT_MAX), text: S.str(REMINDER_TEXT_MAX), projectId: S.str(MAX_ID), taskId: S.str(MAX_ID) }, ['text']),
  output: S.keys('id', 'dueAt', 'status'),
  validate: checkSet,
  handler(ctx, input): ToolResult {
    const now = ctx.now()
    const dueAt = reminderDueAt(input, now)
    if (dueAt === null) return { ok: false, code: 'invalid_due', data: { detail: 'Give exactly one of inMinutes or at (ISO), between 1 minute and 90 days from now.' } }
    const taskId = (input.taskId as string | undefined) ?? null
    const taskProject = taskId ? String(getRow(ctx.db, 'SELECT project_id FROM central_task WHERE id = ?', taskId)?.project_id) : null
    const card = addReminder(ctx.db, {
      projectId: (input.projectId as string | undefined) ?? ownProject(ctx) ?? taskProject, taskId,
      text: (input.text as string).trim(), dueAt, createdBy: CREATED_BY, conversationId: ctx.conversationId, now,
    })
    return { ok: true, data: { id: card.id, dueAt: card.dueAt, status: card.status } }
  },
}

const list: ToolDef = {
  name: 'reminder.list', summary: 'List reminders, pending ones first, soonest due first.', tier: 'R0',
  projectScoped: false, auditKeys: ['hasMore'],
  usage: '{"limit":<1-50, optional>,"offset":<optional>}',
  input: obj({ limit: S.int(1, 50), offset: S.int(0) }, []),
  output: S.keys('items', 'hasMore'),
  validate: (input) => (readPage(input) ? null : 'invalid_shape'),
  handler(ctx, input): ToolResult {
    const own = ownProject(ctx)
    const page = listReminders(ctx.db, { ...(readPage(input) as { limit: number; offset: number }), ...(own ? { projectId: own } : {}) })
    return { ok: true, data: { items: page.items, hasMore: page.hasMore } }
  },
}

const cancel: ToolDef = {
  name: 'reminder.cancel', summary: 'Cancel a pending reminder.', tier: 'R1',
  projectScoped: false, auditKeys: ['id'],
  usage: '{"id":"reminder id from reminder.list"}',
  input: obj({ id: S.str(MAX_ID) }, ['id']),
  output: S.keys('id', 'status'),
  validate: (input) => (isSafeId(input.id) ? null : 'invalid_shape'),
  handler(ctx, input): ToolResult {
    const id = input.id as string
    const result = cancelReminder(ctx.db, id, ownProject(ctx))
    return result === 'cancelled' ? { ok: true, data: { id, status: 'cancelled' } } : { ok: false, code: `reminder_${result}`, data: { id } }
  },
}

/** The reminder tools. */
export const REMINDER_DEFS: readonly ToolDef[] = [set, list, cancel]
