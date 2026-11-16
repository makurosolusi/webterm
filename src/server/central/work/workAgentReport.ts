// Agent -> Central reports (`webterm report`, capability `agent.report`) and the exit of a headless run. Both move the task
// through the ordinary work transitions (`moveTask`), so workCheckin's push wake fires for them like for any other move;
// nothing here starts a turn. A report is also kept as mail (24 h TTL, retention sweep), a timeline event and a chat line.
import type { Database } from 'bun:sqlite'
import type { WorkStatus } from '../../../shared/centralWork'
import { REPORT_RATE_MAX, REPORT_RATE_WINDOW_MS, REPORT_TEXT_MAX, type AgentReportKind } from '../../capability/report.capabilities'
import { previewText } from '../../events/producers'
import { execWrite, getRow, newId } from '../../ledger/ledgerCore'
import { appendCentralNotice } from '../chat/conversationNotice'
import { GLOBAL_CONVERSATION_ID } from '../conversationModel'
import { getConversation } from '../conversationStore'
import type { MailKind } from '../contracts/mail.types'
import { createMailStore } from '../agents/mailStore'
import { AGENT_BLOCKED_RULE, queueCheckinReason } from './workCheckin'
import { AGENT_REPORT_EVENT, AGENT_REPORT_RULE, moveOpenTask } from './workLifecycle'
import type { WorkActor } from './workModel'
import { buildResult } from './workResult'
import { createWorkStore } from './workStore'

const REASON_CHARS = 300

const TARGET: Record<AgentReportKind, WorkStatus | null> = { done: 'reported', blocked: 'waiting_input', question: 'waiting_input', progress: null }
const MAIL_KIND: Record<AgentReportKind, MailKind> = { done: 'done', blocked: 'escalate', question: 'ask', progress: 'msg' }

// ponytail: per-process memory; a restart forgets the window, which only lets one more burst through.
const recent = new Map<string, number[]>()
function rateLimited(nodeId: string, at: number): boolean {
  const kept = (recent.get(nodeId) ?? []).filter((t) => at - t < REPORT_RATE_WINDOW_MS)
  if (kept.length >= REPORT_RATE_MAX) { recent.set(nodeId, kept); return true }
  recent.set(nodeId, [...kept, at])
  return false
}
/** Test hook. */
export function resetReportRateForTest(): void { recent.clear() }

export type ReportResult =
  | { ok: true; data: { reportId: string; kind: AgentReportKind; taskId: string | null; moved: WorkStatus | null; answeredAsk: boolean; mailId: string | null } }
  | { ok: false; code: 'empty_text' | 'text_too_long' | 'not_central_work' | 'rate_limited'; next: string }

/** Records one report from the proven node `nodeId` (input already schema-checked). */
export function recordAgentReport(db: Database, now: () => number, nodeId: string, kind: AgentReportKind, text: string): ReportResult {
  if (text.trim() === '') return { ok: false, code: 'empty_text', next: 'Pass the report text: webterm report "<text>".' }
  if (text.length > REPORT_TEXT_MAX) return { ok: false, code: 'text_too_long', next: `Keep a report under ${REPORT_TEXT_MAX} characters; put long output in a file and name it.` }
  const store = createWorkStore(db, now)
  const assignment = store.openAssignmentOfNode(nodeId)
  const agentId = nodeId.startsWith('c-') ? nodeId.slice(2) : nodeId
  const agent = getRow(db, 'SELECT id, project_id, owner FROM central_agents WHERE node_id = ? OR id = ? ORDER BY started_at DESC LIMIT 1', nodeId, agentId)
  if (!agent && !assignment) return { ok: false, code: 'not_central_work', next: 'Only a session Central started or gave a task can report to it.' }
  if (rateLimited(nodeId, now())) return { ok: false, code: 'rate_limited', next: `At most ${REPORT_RATE_MAX} reports a minute; wait, then send one report that sums up.` }

  const reportId = newId()
  const owner = agent ? String(agent.owner) : ''
  const asked = owner.startsWith('central:') ? owner.slice('central:'.length) : assignment?.conversationId ?? GLOBAL_CONVERSATION_ID
  const conversationId = getConversation(db, asked) ? asked : GLOBAL_CONVERSATION_ID
  const projectId = assignment?.projectId ?? String(agent?.project_id)
  const actor: WorkActor = { kind: 'agent', id: agent ? String(agent.id) : nodeId }
  const reason = `${kind}: ${previewText(text, REASON_CHARS) ?? kind}`

  let mailId: string | null = null
  let answeredAsk = false
  if (agent) {
    const ref = `agent:${String(agent.id)}`
    const mail = createMailStore(db, now)
    const sent = mail.send(ref, { projectId, threadId: '', toRef: `central:${conversationId}`, kind: MAIL_KIND[kind], body: text, reqId: `report:${reportId}` })
    // Central reads it from the chat line and the check-in, so it is delivered now; acking keeps the per-target cap for real mail.
    if (sent.ok) { mailId = sent.mail.id; mail.markDelivered(mailId); mail.ack(mailId, `central:${conversationId}`) }
    // Progress wakes Central only when it asked for it (an open `ask` from Central); that ask is answered by this report.
    const ask = kind === 'progress' ? getRow(db, "SELECT id FROM agent_mail WHERE to_ref = ? AND kind = 'ask' AND from_ref LIKE 'central:%' AND acked_at IS NULL AND expires_at > ? ORDER BY rowid LIMIT 1", ref, now()) : null
    if (ask) {
      execWrite(db, 'UPDATE agent_mail SET acked_at = ? WHERE id = ?', now(), String(ask.id))
      answeredAsk = queueCheckinReason(db, { kind: 'task_report', dedupeKey: `report:${reportId}`, projectId, taskId: assignment?.taskId ?? null, text: `agent ${String(agent.id)} sent the progress you asked for: ${reason}`, now: now(), notBefore: now(), conversationId })
    }
  }
  if (assignment) store.noteAssignment(assignment.id, AGENT_REPORT_EVENT, { actor, rule: AGENT_REPORT_RULE, reason })
  // The report text is the result of a finished attempt: stored (redacted, capped, hashed like a Stop capture) BEFORE the task moves to `reported`.
  if (assignment && kind === 'done') store.recordResult(assignment.id, buildResult('agent_report', text, now()))
  const to = TARGET[kind]
  const moved = to ? moveOpenTask(store, nodeId, to, { actor, rule: kind === 'blocked' ? AGENT_BLOCKED_RULE : AGENT_REPORT_RULE, reason }) : null
  appendCentralNotice(db, { key: `agent-report:${reportId}`, text: `Agent ${agent ? String(agent.id) : nodeId} reported ${kind}: ${text}`, conversationId, now })
  return { ok: true, data: { reportId, kind, taskId: assignment?.taskId ?? null, moved, answeredAsk, mailId } }
}
