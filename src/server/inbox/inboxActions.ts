// Executes one human answer on an inbox item (F3-a): approve / deny / edit / reply / ignore / snooze /
// always, singly or in a batch. Gate decisions go through the ledger approval (the same row Telegram
// buttons decide) and emit the same `inbox.decision` event as Telegram (`gateDecisionEvent`).
// Reply text travels to the agent through the persistent outbox (F2-d), never a raw PTY write.
import type { AppendEventInput } from '../events/eventModel'
import { decideApproval } from '../ledger/ledgerApproval'
import { getRow, tx, type LedgerContext } from '../ledger/ledgerCore'
import { LedgerError } from '../ledger/ledgerModel'
import { FABLE_KIND, FABLE_SCOPES, stampFableScope, type FableScope } from '../models/fableGrant'
import type { EnqueueInput } from '../outbox/outboxStore'
import { decidePermission } from '../permission/permission.human'
import { PERMISSION_KIND } from '../permission/permission.model'
import type { Policy } from '../policy/policy.decide'
import { gateDecisionEvent, INBOX_ACTION_EVENT, type InboxAction, type InboxEntry } from './inboxItemModel'
import { getInboxItem, resolveItem, setItemArgs, snoozeItem, syncApprovalGates } from './inboxItemStore'

export const REPLY_MAX_CHARS = 32 * 1024
export const ARGS_MAX_CHARS = 32 * 1024
const SNOOZE_MAX_MS = 30 * 86_400_000
export const BATCH_MAX = 50

export interface OutboxPort {
  refusal(to: string): string | null
  enqueue(input: EnqueueInput): { deduped: boolean }
}

export interface InboxActDeps {
  ctx: LedgerContext
  /** Audit actor of the human (`human:loopback`, ...). */
  actor: string
  record(event: AppendEventInput): void
  /** Production: the process outbox (`startOutbox`). */
  outbox(): Promise<OutboxPort>
  /** Needed only for `always` (permanent rule). */
  policy?: Policy | null
}

export type ActResult = { status: number; body: Record<string, unknown> }
const fail = (status: number, error: string, detail?: string): ActResult => ({ status, body: { error, ...(detail ? { detail } : {}) } })

function decideGate(deps: InboxActDeps, item: InboxEntry, approve: boolean): ActResult | null {
  const row = getRow(deps.ctx.db, `SELECT d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?`, item.approvalId)
  if (!row) return fail(404, 'approval_missing')
  try {
    decideApproval(deps.ctx, item.approvalId!, { actor: deps.actor, approve, digest: String(row['action_digest']), nonce: String(row['nonce']) })
  } catch (err) {
    // Lost the race with Telegram, another tab or the hook's own expiry: the gate is no longer open.
    if (err instanceof LedgerError) return fail(409, 'not_pending', err.message)
    throw new Error(`inbox decide ${item.id} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  return null
}

function argsTooBig(args: unknown): boolean {
  try { return (JSON.stringify(args) ?? '').length > ARGS_MAX_CHARS } catch { return true }
}

/** Applies `action` to item `id`. Never throws for a human mistake; 4xx explains it. */
export async function actOnItem(deps: InboxActDeps, id: string, action: InboxAction): Promise<ActResult> {
  syncApprovalGates(deps.ctx) // a gate decided on Telegram a second ago must not be decided again here
  const item = getInboxItem(deps.ctx.db, id)
  if (!item) return fail(404, 'not_found')
  if (item.status !== 'open') return fail(409, 'not_open', item.resolution ?? item.status)
  if (!item.actions.includes(action.type)) return fail(400, 'action_not_allowed', `${item.kind} allows ${item.actions.join(', ')}`)
  const note = (payload: Record<string, unknown>): void => deps.record({
    kind: INBOX_ACTION_EVENT, source: 'inbox', actor: deps.actor, trust: 'trusted', subject: `inbox:${id}`,
    nodeId: item.nodeId, workspaceId: item.workspaceId, payload: { itemId: id, kind: item.kind, action: action.type, ...payload },
  })

  switch (action.type) {
    case 'approve':
    case 'deny':
    case 'edit': {
      const approve = action.type !== 'deny'
      if (action.type === 'edit' && argsTooBig(action.args)) return fail(400, 'invalid_args', `args: JSON up to ${ARGS_MAX_CHARS} chars`)
      // Claude's `updatedInput` replaces the whole tool input, so it must stay an object.
      const objectArgs = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)
      if (action.type === 'edit' && item.approvalKind === PERMISSION_KIND && !objectArgs(action.args)) return fail(400, 'invalid_args', 'a tool input must be a JSON object')
      if (item.kind === 'gate') {
        // One transaction: the edited args land together with the approval, never after it
        // (permission.wait polls the approval and returns the args as Claude `updatedInput`).
        const fable = item.approvalKind === FABLE_KIND
        const scope = action.type === 'approve' ? action.scope : undefined
        if (fable && approve && scope !== undefined && !FABLE_SCOPES.includes(scope as FableScope)) return fail(400, 'invalid_scope', `scope: ${FABLE_SCOPES.join(' | ')}`)
        if (fable && action.type === 'edit') return fail(400, 'action_not_allowed', 'a Fable grant cannot be edited')
        const refused = tx(deps.ctx, () => {
          if (action.type === 'edit') setItemArgs(deps.ctx, id, action.args)
          const r = decideGate(deps, item, approve)
          if (!r && fable && approve) stampFableScope(deps.ctx, item.approvalId!, deps.actor, scope as FableScope | undefined)
          return r
        })
        if (refused) return refused
        deps.record(gateDecisionEvent({ approvalId: item.approvalId!, approve, actor: deps.actor, edited: action.type === 'edit' }))
      } else {
        note({})
      }
      const resolution = item.kind === 'review' ? 'accepted' : approve ? 'approved' : 'denied'
      resolveItem(deps.ctx, id, { status: 'done', resolution, by: deps.actor, ...(action.type === 'edit' ? { args: action.args } : {}) })
      return { status: 200, body: { id, resolution } }
    }
    case 'always': {
      const r = decidePermission(deps.ctx.db, deps.policy ?? null, { id: item.approvalId, choice: 'always' }, deps.actor, deps.ctx.now())
      if (r.status !== 200) return { status: r.status, body: r.body as Record<string, unknown> }
      deps.record(gateDecisionEvent({ approvalId: item.approvalId!, approve: true, actor: deps.actor }))
      resolveItem(deps.ctx, id, { status: 'done', resolution: 'approved', by: deps.actor })
      return { status: 200, body: { id, resolution: 'approved', ...(r.body as Record<string, unknown>) } }
    }
    case 'reply': {
      const text = typeof action.text === 'string' ? action.text.trim() : ''
      if (!text || text.length > REPLY_MAX_CHARS) return fail(400, 'invalid_text', `text: 1..${REPLY_MAX_CHARS} chars`)
      if (!item.nodeId) return fail(409, 'no_agent', 'this item has no agent node to reply to')
      const outbox = await deps.outbox()
      const refusal = outbox.refusal(item.nodeId)
      if (refusal) return fail(409, 'bad_target', refusal)
      // One reply per item: the operation id makes a double click (or a retry) the same mail.
      outbox.enqueue({ to: item.nodeId, kind: 'visible', operationId: `inbox:${id}:reply`, createdBy: 'human-ui',
        body: `[webterm] Reply to "${item.title}":\n${text}` })
      resolveItem(deps.ctx, id, { status: 'done', resolution: 'replied', by: deps.actor })
      note({ chars: text.length })
      return { status: 200, body: { id, resolution: 'replied' } }
    }
    case 'ignore':
      resolveItem(deps.ctx, id, { status: 'ignored', resolution: 'ignored', by: deps.actor })
      note({})
      return { status: 200, body: { id, resolution: 'ignored' } }
    case 'snooze': {
      const now = deps.ctx.now()
      if (typeof action.until !== 'number' || !Number.isFinite(action.until) || action.until <= now || action.until > now + SNOOZE_MAX_MS) {
        return fail(400, 'invalid_until', 'until: epoch ms in the next 30 days')
      }
      snoozeItem(deps.ctx, id, Math.trunc(action.until))
      note({ until: Math.trunc(action.until) })
      return { status: 200, body: { id, snoozeUntil: Math.trunc(action.until) } }
    }
  }
}

/**
 * Same action on several items. Approval-fatigue guard (PLAN/rnd/04 §3): an R3 gate (cannot be
 * rewound) is never batch-approved; it stays open and must be approved on its own.
 */
export async function actOnItems(deps: InboxActDeps, ids: readonly string[], action: InboxAction): Promise<Array<{ id: string; status: number; body: Record<string, unknown> }>> {
  const out: Array<{ id: string; status: number; body: Record<string, unknown> }> = []
  for (const id of ids) {
    const item = getInboxItem(deps.ctx.db, id)
    if ((action.type === 'approve' || action.type === 'always') && item?.impact?.tier === 'R3') {
      out.push({ id, status: 409, body: { error: 'needs_individual_review', detail: item.impact.what } })
      continue
    }
    out.push({ id, ...(await actOnItem(deps, id, action)) })
  }
  return out
}
