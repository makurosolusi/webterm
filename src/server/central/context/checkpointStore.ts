// `central_checkpoint` access (schema v8) and the deterministic facts a checkpoint carries (RND/23 §4.3).
import type { Database } from 'bun:sqlite'
import { WORK_STATUSES, WORK_TERMINAL } from '../../../shared/centralWork'
import { CHECKPOINT_NARRATIVE_MAX } from '../../ledger/ledgerSchemaV8'
import { redactSecrets } from '../../redactSecrets'
import { scopeFromConversationId, type MessagePart } from '../conversationModel'

export type CheckpointSource = 'auto' | 'manual' | 'fallback'

export interface Checkpoint {
  id: string
  conversationId: string
  seq: number
  fromMessageId: string | null
  toMessageId: string | null
  /** JSON text, keys in a fixed order. */
  factsJson: string
  narrative: string
  source: CheckpointSource
  createdAt: number
}

export interface CheckpointMessage { id: string; seq: number; role: string; text: string }

/** Entries per fact list; keeps `facts_json` small and the checkpoint block under budget. */
export const FACT_LIST_LIMIT = 10
const FACT_TITLE_CHARS = 80
const SCHEMA_VERSION = 2

const list = (db: Database, sql: string, ...args: unknown[]): Array<Record<string, unknown>> =>
  db.query(sql).all(...args) as Array<Record<string, unknown>>

function textOf(partsJson: string): string {
  const parts = JSON.parse(partsJson) as MessagePart[]
  return parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n')
}

/** Last `limit` messages with plain text, oldest first (state ids stay in `facts`, not here). */
export function recentMessages(
  db: Database, conversationId: string, limit: number, afterSeq = 0, beforeSeq = Number.MAX_SAFE_INTEGER
): CheckpointMessage[] {
  return list(
    db,
    `SELECT id, seq, role, parts_json FROM central_message
     WHERE conversation_id = ? AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
    conversationId, afterSeq, beforeSeq, limit
  ).reverse().map((r) => ({ id: String(r['id']), seq: Number(r['seq']), role: String(r['role']), text: textOf(String(r['parts_json'])) }))
}

/** Sequence number of a message; 0 when unknown so callers fall back to the whole conversation. */
export function messageSeq(db: Database, messageId: string): number {
  const row = db.query('SELECT seq FROM central_message WHERE id = ?').get(messageId) as { seq: number } | null
  return row === null ? 0 : Number(row.seq)
}

/** Newest tool card in the last messages: the most recent proposal and how it ended. */
function lastProposal(db: Database, conversationId: string): { name: string; state: string } | null {
  for (const row of list(db, 'SELECT parts_json FROM central_message WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?', conversationId, FACT_LIST_LIMIT)) {
    const tool = (JSON.parse(String(row['parts_json'])) as MessagePart[]).reverse().find((p) => p.type === 'tool')
    if (tool?.type === 'tool') return { name: tool.name, state: tool.state }
  }
  return null
}

/** Ledger-derived facts for one conversation, no LLM: same ledger gives the same string. */
export function collectFacts(db: Database, conversationId: string): string {
  const scope = scopeFromConversationId(conversationId)
  const projectId = scope.kind === 'project' ? scope.projectId : null
  const filter = projectId === null ? '' : 'AND project_id = ?'
  const args = projectId === null ? [FACT_LIST_LIMIT] : [projectId, FACT_LIST_LIMIT]
  const approvals = list(db, `SELECT id, kind FROM approval WHERE status = 'pending' ${filter} ORDER BY id LIMIT ?`, ...args)
  const tasks = list(db, `SELECT id, status FROM task WHERE status IN ('leased','pending') ${filter} ORDER BY id LIMIT ?`, ...args)
  const open = WORK_STATUSES.filter((status) => !WORK_TERMINAL.includes(status))
  const work = list(db, `SELECT id, title, status FROM central_task WHERE status IN (SELECT value FROM json_each(?)) ${filter} ORDER BY updated_at DESC, id LIMIT ?`, JSON.stringify(open), ...args)
  return JSON.stringify({
    activeTasks: tasks.map((t) => ({ id: String(t['id']), status: String(t['status']) })),
    lastProposal: lastProposal(db, conversationId),
    openWork: work.map((t) => ({ id: String(t['id']), status: String(t['status']), title: redactSecrets(String(t['title'])).slice(0, FACT_TITLE_CHARS) })),
    pendingApprovals: approvals.map((a) => ({ id: String(a['id']), kind: String(a['kind']) })),
    projectId,
    schemaV: SCHEMA_VERSION,
  })
}

const toCheckpoint = (r: Record<string, unknown>): Checkpoint => ({
  id: String(r['id']), conversationId: String(r['conversation_id']), seq: Number(r['seq']),
  fromMessageId: r['from_message_id'] === null ? null : String(r['from_message_id']),
  toMessageId: r['to_message_id'] === null ? null : String(r['to_message_id']),
  factsJson: String(r['facts_json']), narrative: String(r['narrative']),
  source: String(r['source']) as CheckpointSource, createdAt: Number(r['created_at']),
})

/** Newest checkpoint of the conversation, or null. */
export function latestCheckpoint(db: Database, conversationId: string): Checkpoint | null {
  const row = db.query('SELECT * FROM central_checkpoint WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1').get(conversationId)
  return row === null || row === undefined ? null : toCheckpoint(row as Record<string, unknown>)
}

export interface NewCheckpoint {
  conversationId: string
  fromMessageId: string | null
  toMessageId: string | null
  factsJson: string
  narrative: string
  source: CheckpointSource
  model?: string | null
  usage?: unknown
  now: number
}

/** Appends the next checkpoint (seq = max + 1); narrative is redacted then cut to the schema cap. */
export function insertCheckpoint(db: Database, input: NewCheckpoint): Checkpoint {
  const narrative = redactSecrets(input.narrative).slice(0, CHECKPOINT_NARRATIVE_MAX)
  const id = `ckpt_${crypto.randomUUID()}`
  db.query(
    `INSERT INTO central_checkpoint
       (id, conversation_id, seq, from_message_id, to_message_id, schema_v, facts_json, narrative, model, usage_json, source, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM central_checkpoint WHERE conversation_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.conversationId, input.conversationId, input.fromMessageId, input.toMessageId, SCHEMA_VERSION,
    input.factsJson, narrative, input.model ?? null, input.usage === undefined ? null : JSON.stringify(input.usage),
    input.source, input.now
  )
  const saved = latestCheckpoint(db, input.conversationId)
  if (saved === null || saved.id !== id) throw new Error(`checkpoint insert not visible for ${input.conversationId}`)
  return saved
}
