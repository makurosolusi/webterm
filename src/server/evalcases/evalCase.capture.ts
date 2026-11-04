// Capture: turns user rejections already recorded in the ledger into `eval_case` rows. Pull-based like
// `syncApprovalGates` (inbox): no producer is edited, every surface (Inbox, Telegram, control API,
// Central MCP card) lands in the same rows, and history from before v21 is picked up too. Idempotent:
// `source_ref` is UNIQUE and every query skips refs that already have a case (dismissed ones included).
//
//   approval  status = 'rejected'                -> `central_plan` (request carries a conversation) or `approval`
//   memory_event 'memory.forget' on a consolidator proposal -> `memory_proposal` (text stays forgotten)
//   event 'checkpoint.rewound' (Senses log)       -> `rewind`
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, newId, parseJson, type Row } from '../ledger/ledgerCore'
import { CONSOLIDATOR_SOURCE } from '../memory/consolidator/consolidator.store'
import { INPUT_MAX_CHARS, scrubText, scrubValue, type EvalCaseSource, type ProposedAction, type Rejection } from './evalCase.model'

/** Rows captured per source per sync; the next read picks up the rest. */
export const CAPTURE_BATCH = 200

interface NewCase {
  source: EvalCaseSource
  sourceRef: string
  projectId?: string | null
  workspaceId?: string | null
  nodeId?: string | null
  contextRef?: string | null
  inputText?: string | null
  proposed: ProposedAction
  rejection: Rejection
  rejectedAt: number
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const notCaptured = (refSql: string): string => `NOT EXISTS (SELECT 1 FROM eval_case e WHERE e.source_ref = ${refSql})`

function insert(db: Database, c: NewCase, secrets: readonly string[], now: number): void {
  const input = c.inputText ? scrubText(c.inputText, secrets).slice(0, INPUT_MAX_CHARS) : null
  execWrite(db, `INSERT OR IGNORE INTO eval_case (id, source, source_ref, project_id, workspace_id, node_id, context_ref, input_text,
      proposed_json, rejection_json, rejected_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  newId(), c.source, c.sourceRef, c.projectId ?? null, c.workspaceId ?? null, c.nodeId ?? null, c.contextRef ?? null, input,
  JSON.stringify(scrubValue(c.proposed, secrets)), JSON.stringify(scrubValue(c.rejection, secrets)), c.rejectedAt, now, now)
}

/** Text of the last human message in `conversationId` at or before `at` (what Central was answering). */
function humanInput(db: Database, conversationId: string, at: number): string | null {
  const row = getRow(db, `SELECT parts_json FROM central_message WHERE conversation_id = ? AND role = 'human' AND created_at <= ?
    ORDER BY seq DESC LIMIT 1`, conversationId, at)
  if (!row) return null
  const parts = parseJson(row['parts_json'])
  const text = Array.isArray(parts) ? parts.map((p) => (obj(p)['type'] === 'text' ? String(obj(p)['text'] ?? '') : '')).join('\n').trim() : ''
  return text || null
}

function fromApproval(db: Database, r: Row): NewCase {
  const req = obj(parseJson(r['request_json']))
  const conversationId = str(req['conversationId'])
  const tool = str(req['tool']) ?? String(r['kind'])
  const label = str(req['label']) ?? str(req['title'])
  return {
    source: conversationId ? 'central_plan' : 'approval',
    sourceRef: `approval:${String(r['id'])}`,
    projectId: str(r['project_id']), workspaceId: str(r['ws']), nodeId: str(req['nodeId']),
    contextRef: conversationId ? `conversation:${conversationId}` : null,
    inputText: conversationId ? humanInput(db, conversationId, Number(r['created_at'])) : null,
    proposed: {
      tool, args: req['input'] ?? req['args'] ?? null,
      ...(str(req['inputDigest']) ? { inputDigest: String(req['inputDigest']) } : {}),
      summary: label ? `${tool}: ${label}` : tool,
    },
    rejection: { by: str(r['approved_by']) ?? 'human', how: 'approval' },
    rejectedAt: Number(r['updated_at']),
  }
}

function fromForget(db: Database, r: Row): NewCase {
  const propose = getRow(db, `SELECT payload_json FROM memory_event WHERE memory_id = ? AND kind = 'memory.consolidate.propose' ORDER BY seq LIMIT 1`, r['memory_id'])
  const p = obj(parseJson(propose?.['payload_json']))
  const op = str(p['op']) ?? 'add'
  return {
    source: 'memory_proposal',
    sourceRef: `memory_event:${String(r['seq'])}`,
    projectId: str(r['project_id']), nodeId: str(p['node']), contextRef: str(r['source_ref']),
    // The body is erased by forget (tombstone): the case keeps the shape of the proposal, never its text.
    proposed: { tool: `memory.${op}`, args: { kind: str(r['mkind']), targetId: str(p['targetId']) }, summary: `Consolidator proposed to ${op} a ${str(r['mkind']) ?? 'memory'}` },
    rejection: { by: String(r['actor']), how: 'memory.forget' },
    rejectedAt: Number(r['ts']),
  }
}

function fromRewind(db: Database, r: Row): NewCase {
  const subject = String(r['subject'])
  const created = getRow(db, `SELECT node_id, payload_json FROM event WHERE kind = 'checkpoint.created' AND subject = ? AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1`, subject)
  const why = str(obj(parseJson(created?.['payload_json']))['reason'])
  const seq = obj(parseJson(r['payload_json']))['seq']
  return {
    source: 'rewind',
    sourceRef: `event:${String(r['seq'])}`,
    workspaceId: str(r['workspace_id']), nodeId: str(created?.['node_id']), contextRef: subject,
    proposed: { tool: 'checkpoint.changes', args: { seq, reason: why }, summary: `Changes made after checkpoint ${String(seq)}${why ? ` (${why})` : ''}` },
    rejection: { by: String(r['actor']), how: 'checkpoint.rewound' },
    rejectedAt: Number(r['ts']),
  }
}

/** Captures every not-yet-captured rejection; returns how many cases were added. */
export function syncEvalCases(db: Database, opts: { now: number; secrets: readonly string[] }): number {
  const before = Number(getRow(db, 'SELECT COUNT(*) AS n FROM eval_case')?.['n'] ?? 0)
  const approvals = allRows(db, `SELECT a.*, p.workspace_id AS ws FROM approval a LEFT JOIN project p ON p.id = a.project_id
    WHERE a.status = 'rejected' AND ${notCaptured(`'approval:' || a.id`)} ORDER BY a.updated_at LIMIT ?`, CAPTURE_BATCH)
  const forgets = allRows(db, `SELECT me.seq, me.memory_id, me.ts, me.actor, m.project_id, m.source_ref, m.kind AS mkind
    FROM memory_event me JOIN memory m ON m.id = me.memory_id
    WHERE me.kind = 'memory.forget' AND m.source_kind = ? AND ${notCaptured(`'memory_event:' || me.seq`)} ORDER BY me.seq LIMIT ?`, CONSOLIDATOR_SOURCE, CAPTURE_BATCH)
  const rewinds = allRows(db, `SELECT ev.seq, ev.ts, ev.actor, ev.subject, ev.workspace_id, ev.payload_json FROM event ev
    WHERE ev.kind = 'checkpoint.rewound' AND ev.hash IS NOT NULL AND ${notCaptured(`'event:' || ev.seq`)} ORDER BY ev.seq LIMIT ?`, CAPTURE_BATCH)
  const cases = [...approvals.map((r) => fromApproval(db, r)), ...forgets.map((r) => fromForget(db, r)), ...rewinds.map((r) => fromRewind(db, r))]
  for (const c of cases) insert(db, c, opts.secrets, opts.now)
  return Number(getRow(db, 'SELECT COUNT(*) AS n FROM eval_case')?.['n'] ?? 0) - before
}
