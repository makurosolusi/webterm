// Live approval frames for the Central chat. Every card change goes through the ledger hook
// (`onApprovalChange`), so a decision from any surface (chat card, Telegram, legacy routes) and the
// expiry sweep reach the owning conversation as `approval.requested` / `approval.updated`
// `{ approvalId, state, title? }`. The approval part is persisted at request time so a reload shows it.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, type LedgerContext } from '../../ledger/ledgerCore'
import { type Approval, type ApprovalStatus, expireApprovals, getApproval, onApprovalChange } from '../../ledger/ledgerApproval'
import { createLogger } from '../../logs'
import { ConversationError, type MessagePart, type ToolCardState } from '../conversationModel'
import { appendConversationEvent, appendMessage, getConversation } from '../conversationStore'
import type { StreamHub } from './streamHub'

/** Exact frame payload of `approval.requested` / `approval.updated` (the client builds against it). */
export interface ApprovalFrame { approvalId: string; state: ApprovalStatus; title?: string }

/** How often pending cards past their TTL are marked expired (and their frame sent). */
export const APPROVAL_EXPIRY_SWEEP_MS = 30_000

const log = createLogger('central.approvals')
const hubs = new WeakMap<Database, Set<StreamHub>>()
const sweeps = new WeakSet<Database>()

/** Persisted part state of a card: the chat part model has no approved/expired, so they map onto it. */
export function approvalPartState(status: ApprovalStatus): ToolCardState {
  return status === 'pending' ? 'awaiting_approval' : status === 'approved' ? 'succeeded' : status === 'rejected' ? 'denied' : 'cancelled'
}

/** Current part state of a card, or the turn-time default when the ledger no longer has it. */
export function currentPartState(db: Database, approvalId: string, now: () => number): ToolCardState {
  const approval = getApproval({ db, now }, approvalId)
  return approval ? approvalPartState(approval.status) : 'awaiting_approval'
}

/** Makes `stream` receive approval frames of conversations on `db`, and starts the expiry sweep once per db. */
export function registerApprovalStream(db: Database, stream: StreamHub, now: () => number = Date.now): void {
  const set = hubs.get(db) ?? new Set<StreamHub>()
  set.add(stream)
  hubs.set(db, set)
  if (sweeps.has(db)) return
  sweeps.add(db)
  const timer = setInterval(() => {
    try {
      expireApprovals({ db, now })
    } catch (err) {
      log.error('approval.expiry_sweep_failed', 'approval expiry sweep threw', { error: err instanceof Error ? err.message : String(err) })
    }
  }, APPROVAL_EXPIRY_SWEEP_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/** Conversation that asked for the card: MCP cards carry it, agent cards resolve through the agent's owner. */
function ownerConversation(db: Database, approval: Approval): string | null {
  const request = asRecord(approval.request)
  let id: string | null = typeof request['conversationId'] === 'string' ? request['conversationId'] : null
  if (!id && approval.kind === 'agent.spawn' && typeof request['agentId'] === 'string') {
    const owner = getRow(db, 'SELECT owner FROM central_agents WHERE id = ?', request['agentId'])?.['owner']
    id = typeof owner === 'string' && owner.startsWith('central:') ? owner.slice('central:'.length) : null
  }
  if (!id) return null
  try {
    return getConversation(db, id) ? id : null
  } catch (err) {
    // A malformed id names no conversation: there is nobody to show the card to.
    if (err instanceof ConversationError) return null
    throw err
  }
}

function titleOf(approval: Approval): string | undefined {
  const r = asRecord(approval.request)
  if (typeof r['title'] === 'string') return r['title']
  if (approval.kind === 'agent.spawn' && typeof r['kind'] === 'string') return `Start a ${r['kind']} ${typeof r['role'] === 'string' ? r['role'] : ''} agent`.replace(/\s+/g, ' ')
  if (typeof r['tool'] === 'string') return `Run ${r['tool']}`
  return undefined
}

/** Adds the card to the reply being streamed, or to a message of its own when no turn is streaming. */
function persistRequested(db: Database, conversationId: string, approval: Approval, now: number): void {
  const part: MessagePart = { type: 'approval', approvalId: approval.id, state: 'awaiting_approval', ...(approval.expiresAt === null ? {} : { expiresAt: approval.expiresAt }) }
  const streaming = getRow(db, `SELECT id, parts_json FROM central_message WHERE conversation_id = ? AND role = 'assistant' AND state = 'streaming'
    ORDER BY seq DESC LIMIT 1`, conversationId)
  if (!streaming) {
    appendMessage(db, { conversationId, role: 'assistant', parts: [part], state: 'complete', now })
    return
  }
  const parts = JSON.parse(String(streaming['parts_json'])) as MessagePart[]
  if (parts.some((p) => p.type === 'approval' && p.approvalId === approval.id)) return
  execWrite(db, 'UPDATE central_message SET parts_json = ? WHERE id = ?', JSON.stringify([...parts, part]), String(streaming['id']))
}

/** Rewrites the persisted card(s) of a decided/expired approval so a reload shows the outcome. */
function persistUpdated(db: Database, conversationId: string, approval: Approval): void {
  const state = approvalPartState(approval.status)
  // LIKE only narrows the scan; the exact id match happens on the parsed parts.
  const rows = allRows(db, 'SELECT id, parts_json FROM central_message WHERE conversation_id = ? AND parts_json LIKE ?', conversationId, `%${approval.id}%`)
  for (const row of rows) {
    const parts = JSON.parse(String(row['parts_json'])) as MessagePart[]
    let changed = false
    const next = parts.map((p) => {
      if (p.type !== 'approval' || p.approvalId !== approval.id || p.state === state) return p
      changed = true
      return { ...p, state }
    })
    if (changed) execWrite(db, 'UPDATE central_message SET parts_json = ? WHERE id = ?', JSON.stringify(next), String(row['id']))
  }
}

/** Ledger listener: persist the part, append the event, then fan it out to every registered hub. */
export function publishApprovalChange(ctx: LedgerContext, approval: Approval): void {
  const conversationId = ownerConversation(ctx.db, approval)
  if (!conversationId) return
  const now = ctx.now()
  const requested = approval.status === 'pending'
  if (requested) persistRequested(ctx.db, conversationId, approval, now)
  else persistUpdated(ctx.db, conversationId, approval)
  const title = titleOf(approval)
  const frame: ApprovalFrame = { approvalId: approval.id, state: approval.status, ...(title ? { title } : {}) }
  const event = appendConversationEvent(ctx.db, { conversationId, type: requested ? 'approval.requested' : 'approval.updated', payload: frame, now })
  for (const hub of hubs.get(ctx.db) ?? []) hub.publish(conversationId, event)
}

onApprovalChange(publishApprovalChange)
