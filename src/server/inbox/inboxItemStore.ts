// Persistence of unified inbox items (F3-a) over the ledger `inbox_item` table (schema v14).
//
// Every gate is a ledger approval: `createGate` requests one, and `syncApprovalGates` mirrors any
// approval another producer requested (Claude permission prompts, task reviews, Central gates) into
// one row each. So Telegram buttons, digest/nonce, expiry and single use stay the ledger's job, and
// this table only adds snooze, ignore, edited args, coalescing and push state.
import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { requestApproval } from '../ledger/ledgerApproval'
import { allRows, execWrite, getRow, newId, type LedgerContext, type Row } from '../ledger/ledgerCore'
import { PERMISSION_KIND } from '../permission/permission.model'
import { allowedActions, toolImpact, type Impact, type InboxEntry, type InboxItemKind, type InboxItemStatus } from './inboxItemModel'

/** Ledger approval kind of a gate created through the inbox (producer reads the final args back). */
export const INBOX_GATE_KIND = 'inbox.gate'
export const GATE_ID_PREFIX = 'gate_'
const LIST_MAX = 200
const TITLE_MAX = 160
const BODY_MAX = 4000
const DIGEST_LINES = 20
const DAY_MS = 86_400_000
const TIERS = new Set(['R0', 'R1', 'R2', 'R3'])

export interface NewItemInput {
  kind: Exclude<InboxItemKind, 'gate'>
  source: string
  title: string
  body?: string | null
  projectId?: string | null
  workspaceId?: string | null
  nodeId?: string | null
  /** Same key = the same news again: the open row's count goes up instead of a new row. */
  dedupeKey?: string | null
}

export interface NewGateInput {
  projectId: string
  source: string
  title: string
  args: unknown
  impact: Impact
  editable?: boolean
  body?: string | null
  workspaceId?: string | null
  nodeId?: string | null
  ttlMs?: number
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))
const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return null
  try { return JSON.parse(v) } catch { return null }
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

const SELECT = `SELECT i.*, a.kind AS approval_kind, a.request_json AS approval_request FROM inbox_item i LEFT JOIN approval a ON a.id = i.approval_id`

/** "Always allow this pattern" only for a Claude prompt with a safe pattern (permission.wait `pattern`). */
const alwaysAllowed = (r: Row): boolean =>
  r['approval_kind'] === PERMISSION_KIND && typeof (parse(r['approval_request']) as { pattern?: unknown } | null)?.pattern === 'string'

function toEntry(r: Row): InboxEntry {
  const kind = r['kind'] as InboxItemKind
  const editable = Number(r['editable']) === 1
  return {
    id: String(r['id']), kind, source: String(r['source']),
    projectId: (r['project_id'] as string | null) ?? null,
    workspaceId: (r['workspace_id'] as string | null) ?? null,
    nodeId: (r['node_id'] as string | null) ?? null,
    approvalId: (r['approval_id'] as string | null) ?? null,
    approvalKind: (r['approval_kind'] as string | null) ?? null,
    title: String(r['title']), body: (r['body'] as string | null) ?? null,
    impact: parse(r['impact_json']) as Impact | null,
    args: parse(r['args_json']),
    status: r['status'] as InboxItemStatus,
    resolution: (r['resolution'] as string | null) ?? null,
    snoozeUntil: num(r['snooze_until']),
    count: Number(r['repeat_count']),
    actions: alwaysAllowed(r) ? [...allowedActions(kind, editable), 'always'] : allowedActions(kind, editable),
    createdAt: Number(r['created_at']), updatedAt: Number(r['updated_at']),
  }
}

export function getInboxItem(db: Database, id: string): InboxEntry | null {
  const r = getRow(db, `${SELECT} WHERE i.id = ?`, id)
  return r ? toEntry(r) : null
}

/** Args the human approved, edits included. F3-b can return these as `updatedInput`. */
export function approvedArgsFor(db: Database, approvalId: string): unknown {
  const r = getRow(db, 'SELECT args_json FROM inbox_item WHERE approval_id = ?', approvalId)
  return r ? parse(r['args_json']) : null
}

/** notify / question / review. A repeated `dedupeKey` coalesces into the open row (count + 1). */
export function createInboxItem(ctx: LedgerContext, input: NewItemInput): InboxEntry {
  const now = ctx.now()
  if (input.dedupeKey) {
    const bumped = execWrite(ctx.db, `UPDATE inbox_item SET repeat_count = repeat_count + 1, updated_at = ?, title = ?
      WHERE dedupe_key = ? AND status = 'open'`, now, clip(input.title, TITLE_MAX), input.dedupeKey)
    const existing = getRow(ctx.db, 'SELECT id, status FROM inbox_item WHERE dedupe_key = ?', input.dedupeKey)
    if (bumped > 0 && existing) return getInboxItem(ctx.db, String(existing['id']))!
    // A closed row keeps its key for history; the new occurrence is fresh news under a fresh key.
    if (existing) execWrite(ctx.db, 'UPDATE inbox_item SET dedupe_key = NULL WHERE id = ?', existing['id'])
  }
  const id = newId()
  execWrite(ctx.db, `INSERT INTO inbox_item (id, kind, source, project_id, workspace_id, node_id, title, body, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.kind, input.source, input.projectId ?? null, input.workspaceId ?? null,
  input.nodeId ?? null, clip(input.title, TITLE_MAX), input.body ? input.body.slice(0, BODY_MAX) : null, input.dedupeKey ?? null, now, now)
  return getInboxItem(ctx.db, id)!
}

/** A gate = a ledger approval plus its inbox row; the approval decides, the row carries the args. */
export function createGate(ctx: LedgerContext, input: NewGateInput): InboxEntry {
  const approvalId = `${GATE_ID_PREFIX}${randomBytes(8).toString('hex')}`
  requestApproval(ctx, { id: approvalId, projectId: input.projectId, kind: INBOX_GATE_KIND, request: { title: input.title, args: input.args ?? null }, ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}) })
  const now = ctx.now()
  execWrite(ctx.db, `INSERT INTO inbox_item (id, kind, source, project_id, workspace_id, node_id, approval_id, title, body, impact_json, args_json, editable, created_at, updated_at)
    VALUES (?, 'gate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, approvalId, input.source, input.projectId, input.workspaceId ?? null, input.nodeId ?? null,
  approvalId, clip(input.title, TITLE_MAX), input.body ?? null, json(input.impact), json(input.args ?? null), input.editable ? 1 : 0, now, now)
  return getInboxItem(ctx.db, approvalId)!
}

function mirrorOf(r: Row): { title: string; impact: Impact; nodeId: string | null; args: unknown; editable: boolean } {
  const kind = String(r['kind'])
  const req = (parse(r['request_json']) ?? {}) as Record<string, unknown>
  if (kind === PERMISSION_KIND && typeof req.label === 'string') {
    const tool = typeof req.tool === 'string' ? req.tool : 'tool'
    // `input` = the tool input Claude asked with (permission.wait); editing it becomes `updatedInput`.
    const editable = req.input !== undefined && req.input !== null
    return { title: clip(`${String(req.node ?? 'agent')} wants to run: ${req.label}`, TITLE_MAX), impact: toolImpact(tool, req.label), nodeId: typeof req.nodeId === 'string' ? req.nodeId : null, args: editable ? req.input : null, editable }
  }
  const tier = typeof req.tier === 'string' && TIERS.has(req.tier) ? (req.tier as Impact['tier']) : 'R2'
  return { title: clip(`Approval: ${kind}`, TITLE_MAX), impact: { what: `Allows the pending ${kind} action`, tier, rewindable: false }, nodeId: null, args: null, editable: false }
}

/**
 * Mirrors pending approvals into gate rows and closes rows whose approval left `pending`
 * (decided on any surface, expired, or answered in the terminal). Idempotent.
 */
export function syncApprovalGates(ctx: LedgerContext): void {
  const now = ctx.now()
  execWrite(ctx.db, `UPDATE inbox_item SET status = 'done', updated_at = ?,
      resolution = COALESCE(resolution, (SELECT CASE WHEN a.status = 'pending' THEN 'expired' ELSE a.status END FROM approval a WHERE a.id = inbox_item.approval_id))
    WHERE kind = 'gate' AND status != 'done' AND approval_id IN
      (SELECT id FROM approval WHERE status != 'pending' OR (expires_at IS NOT NULL AND expires_at <= ?))`, now, now)
  const fresh = allRows(ctx.db, `SELECT a.*, p.workspace_id AS ws FROM approval a LEFT JOIN project p ON p.id = a.project_id
    WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM inbox_item i WHERE i.approval_id = a.id) LIMIT ?`, now, LIST_MAX)
  for (const r of fresh) {
    const m = mirrorOf(r)
    execWrite(ctx.db, `INSERT OR IGNORE INTO inbox_item (id, kind, source, project_id, workspace_id, node_id, approval_id, title, impact_json, args_json, editable, created_at, updated_at)
      VALUES (?, 'gate', 'approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, String(r['id']), r['project_id'] ?? null, r['ws'] ?? null, m.nodeId,
    String(r['id']), m.title, json(m.impact), json(m.args), m.editable ? 1 : 0, Number(r['created_at']), now)
  }
}

/** Source of review items mirrored from Diff "Send to agent" notes (outbox `diff-notes:` mail). */
export const DIFF_NOTES_SOURCE = 'diff-notes'
const DIFF_NOTES_OP = 'diff-notes:'
const COUNT_RE = /\((\d+)\):/

/**
 * Diff review notes sent to an agent become a `review` item, so the Inbox shows what is waiting on
 * the agent (F3-a). Pull-based like `syncApprovalGates`: the outbox row is the source, mirrored once
 * (`dedupe_key = outbox:<id>`), only for mail of the last 24 h so an upgrade does not resurrect history.
 */
export function syncDiffNoteReviews(ctx: LedgerContext): void {
  const now = ctx.now()
  const mail = allRows(ctx.db, `SELECT o.id, o.to_node, o.body, o.created_at FROM agent_outbox o
    WHERE substr(o.operation_id, 1, ?) = ? AND o.status != 'cancelled' AND o.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM inbox_item i WHERE i.dedupe_key = 'outbox:' || o.id) LIMIT ?`,
  DIFF_NOTES_OP.length, DIFF_NOTES_OP, now - DAY_MS, LIST_MAX)
  for (const m of mail) {
    const count = Number(COUNT_RE.exec(String(m['body']))?.[1] ?? 0)
    createInboxItem(ctx, {
      kind: 'review', source: DIFF_NOTES_SOURCE, nodeId: String(m['to_node']), dedupeKey: `outbox:${String(m['id'])}`,
      title: count > 0 ? `Review notes sent to the agent (${count})` : 'Review notes sent to the agent',
      body: String(m['body']),
    })
  }
}

const localDay = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Once per local day: one notify item summing up the last 24 h of notify news (plan §3 digest). */
export function ensureDailyDigest(ctx: LedgerContext): InboxEntry | null {
  const now = ctx.now()
  const key = `digest:${localDay(now)}`
  if (getRow(ctx.db, 'SELECT 1 AS x FROM inbox_item WHERE dedupe_key = ?', key)) return null
  const news = allRows(ctx.db, `SELECT title, repeat_count FROM inbox_item WHERE kind = 'notify' AND source != 'digest'
    AND created_at >= ? AND created_at < ? ORDER BY created_at DESC`, now - DAY_MS, now)
  if (news.length === 0) return null
  const lines = news.slice(0, DIGEST_LINES).map((r) => `- ${String(r['title'])}${Number(r['repeat_count']) > 1 ? ` (×${Number(r['repeat_count'])})` : ''}`)
  if (news.length > DIGEST_LINES) lines.push(`- and ${news.length - DIGEST_LINES} more`)
  return createInboxItem(ctx, { kind: 'notify', source: 'digest', title: `Daily digest: ${news.length} update${news.length === 1 ? '' : 's'}`, body: lines.join('\n'), dedupeKey: key })
}

/** Open, un-snoozed items (snoozed ones resurface by themselves once `until` passes). */
export function listInboxItems(ctx: LedgerContext, opts: { projectId?: string; limit?: number } = {}): InboxEntry[] {
  syncApprovalGates(ctx)
  syncDiffNoteReviews(ctx)
  ensureDailyDigest(ctx)
  const limit = Math.min(LIST_MAX, Math.max(1, opts.limit ?? LIST_MAX))
  const scope = opts.projectId === undefined ? '' : ' AND i.project_id = ?'
  return allRows(ctx.db, `${SELECT} WHERE i.status = 'open' AND (i.snooze_until IS NULL OR i.snooze_until <= ?)${scope}
    ORDER BY CASE i.kind WHEN 'gate' THEN 0 WHEN 'question' THEN 1 WHEN 'review' THEN 2 ELSE 3 END, i.created_at ASC, i.id ASC LIMIT ?`,
  ctx.now(), ...(opts.projectId === undefined ? [] : [opts.projectId]), limit).map(toEntry)
}

/** Open items whose Telegram card has not gone out yet (the push sweep's work list). */
export function unpushedItems(ctx: LedgerContext): InboxEntry[] {
  return allRows(ctx.db, `${SELECT} WHERE i.status = 'open' AND i.pushed_at IS NULL AND (i.snooze_until IS NULL OR i.snooze_until <= ?)
    ORDER BY i.created_at ASC LIMIT ?`, ctx.now(), LIST_MAX).map(toEntry)
}

export function markPushed(ctx: LedgerContext, id: string): void {
  execWrite(ctx.db, 'UPDATE inbox_item SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL', ctx.now(), id)
}

export function resolveItem(ctx: LedgerContext, id: string, change: { status: InboxItemStatus; resolution: string; by: string; args?: unknown }): void {
  execWrite(ctx.db, `UPDATE inbox_item SET status = ?, resolution = ?, resolved_by = ?, updated_at = ?${change.args === undefined ? '' : ', args_json = ?'} WHERE id = ?`,
    change.status, change.resolution, change.by, ctx.now(), ...(change.args === undefined ? [] : [json(change.args)]), id)
}

/** Writes the edited args BEFORE the approval is decided, so a waiting reader never sees approval without them. */
export function setItemArgs(ctx: LedgerContext, id: string, args: unknown): void {
  execWrite(ctx.db, 'UPDATE inbox_item SET args_json = ?, updated_at = ? WHERE id = ?', json(args), ctx.now(), id)
}

export function snoozeItem(ctx: LedgerContext, id: string, until: number): void {
  // pushed_at resets: resurfacing is the point of a snooze, so the card goes out again then.
  execWrite(ctx.db, 'UPDATE inbox_item SET snooze_until = ?, pushed_at = NULL, updated_at = ? WHERE id = ?', until, ctx.now(), id)
}
