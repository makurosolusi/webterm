// Central's reminders: what it asked to be told about later. The check-in engine fires them; tools and routes manage them.
import type { Database } from 'bun:sqlite'
import type { ReminderCard, ReminderPage, ReminderStatus } from '../../../shared/centralWork'
import { allRows, execWrite, getRow, newId, type Row } from '../../ledger/ledgerCore'
import { redactSecrets } from '../../redactSecrets'

const MINUTE_MS = 60_000
export const REMINDER_MIN_MINUTES = 1
export const REMINDER_MAX_MINUTES = 90 * 24 * 60
export const REMINDER_TEXT_MAX = 500

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const SELECT = 'SELECT r.*, p.name AS project_name FROM central_reminder r LEFT JOIN project p ON p.id = r.project_id'

function toCard(r: Row): ReminderCard {
  return { id: String(r.id), projectId: str(r.project_id), projectName: str(r.project_name), taskId: str(r.task_id), text: String(r.text), dueAt: Number(r.due_at), status: r.status as ReminderStatus }
}

/** The due time of `{inMinutes}` or `{at}` (exactly one), or null when missing, malformed or outside 1 minute to 90 days. */
export function reminderDueAt(input: { inMinutes?: unknown; at?: unknown }, now: number): number | null {
  if ((input.inMinutes === undefined) === (input.at === undefined)) return null
  const due = input.at === undefined ? now + Number(input.inMinutes) * MINUTE_MS : Date.parse(String(input.at))
  return due >= now + REMINDER_MIN_MINUTES * MINUTE_MS && due <= now + REMINDER_MAX_MINUTES * MINUTE_MS ? due : null
}

/** Stores a pending reminder; the text is redacted first. */
export function addReminder(db: Database, input: { projectId: string | null; taskId: string | null; text: string; dueAt: number; createdBy: string; conversationId: string | null; now: number }): ReminderCard {
  const id = newId()
  execWrite(db, 'INSERT INTO central_reminder (id, project_id, task_id, text, due_at, created_by, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, input.projectId, input.taskId, redactSecrets(input.text).slice(0, REMINDER_TEXT_MAX), input.dueAt, input.createdBy, input.conversationId, input.now)
  return toCard(getRow(db, `${SELECT} WHERE r.id = ?`, id) as Row)
}

/** Pending first, then soonest due; `projectId` narrows to one project. */
export function listReminders(db: Database, page: { limit: number; offset: number; projectId?: string }): ReminderPage {
  const where = page.projectId ? 'WHERE r.project_id = ?' : ''
  const rows = allRows(db, `${SELECT} ${where} ORDER BY r.status = 'pending' DESC, r.due_at, r.id LIMIT ? OFFSET ?`, ...(page.projectId ? [page.projectId] : []), page.limit + 1, page.offset)
  return { items: rows.slice(0, page.limit).map(toCard), hasMore: rows.length > page.limit }
}

/** Cancels a pending reminder; `projectId` refuses one of another project as not found. */
export function cancelReminder(db: Database, id: string, projectId?: string): 'cancelled' | 'not_found' | 'not_pending' {
  const row = getRow(db, 'SELECT status, project_id FROM central_reminder WHERE id = ?', id)
  if (!row || (projectId !== undefined && row.project_id !== projectId)) return 'not_found'
  return execWrite(db, "UPDATE central_reminder SET status = 'cancelled' WHERE id = ? AND status = 'pending'", id) === 1 ? 'cancelled' : 'not_pending'
}

/** Pending reminders whose time has come, oldest first. */
export function dueReminders(db: Database, at: number, limit: number): ReminderCard[] {
  return allRows(db, `${SELECT} WHERE r.status = 'pending' AND r.due_at <= ? ORDER BY r.due_at, r.id LIMIT ?`, at, limit).map(toCard)
}

/** Marks a reminder fired; false when something else settled it first. */
export function markReminderFired(db: Database, id: string, at: number): boolean {
  return execWrite(db, "UPDATE central_reminder SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'pending'", at, id) === 1
}
