// Approve/deny bridge between chat text and `ledger.approval`. Split from the dispatcher so the
// consent rules stay reviewable on their own: the ledger remains the only authority on digest,
// nonce, expiry and single-use state, and this file only translates a parsed command into it.
import type { ChannelCommand } from './identity'
import type { NormalizedMessage } from './telegram'
import { safeErrorText } from './safeErrorText'
import type { ChannelBinding } from './identity'

/** Minimal approval shape; the real `ledger.approval` is structurally compatible. */
export interface ApprovalSummary {
  id: string
  projectId: string | null
  status: string
  kind?: string
  expiresAt?: number | null
}

/** Injected so the dispatcher stays pure and tests never open SQLite. */
export interface ChannelApprovalPort {
  listApprovals(opts?: { projectId?: string; status?: string; limit?: number }): ApprovalSummary[]
  getApproval(id: string): ApprovalSummary | null
  decideApproval(
    id: string,
    input: { actor: string; approve: boolean; digest: string; nonce: string }
  ): unknown
  consumeApproval(id: string, input: { digest: string }): boolean
}

export interface ApprovalDeps {
  approval?: ChannelApprovalPort
  /**
   * Chat consent normally only records the decision; the executor consumes it right before the
   * action so a crash cannot re-run anything. Set this only when the channel itself is the
   * executor (nothing in v1 does), otherwise the action would find its consent already spent.
   */
  consumeOnApprove?: boolean
}

export function actorFor(userId: string): string {
  return `telegram:${userId}`
}

/** Pull the digest + nonce that the approval card showed; anything else is not a challenge. */
export function extractRejectChallenge(
  reason: string | undefined
): { digest: string; nonce: string; reason: string } | null {
  const tokens = (reason ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null
  const [digest, nonce, ...rest] = tokens
  if (!/^[0-9a-fA-F]{64}$/.test(digest)) return null
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return null
  return { digest, nonce, reason: rest.join(' ') }
}

function checkScope(
  current: ApprovalSummary | null,
  binding: ChannelBinding,
  id: string,
  verb: 'approve' | 'deny'
): string | null {
  if (!current) return `Unknown approval ${id}. Nothing was ${verb === 'approve' ? 'approved' : 'denied'}.`
  if (current.projectId !== null && current.projectId !== binding.projectId) {
    return `Approval ${id} belongs to another project. Denied.`
  }
  if (current.status !== 'pending') return `Approval ${id} is already ${current.status}.`
  return null
}

export function handleApprove(
  deps: ApprovalDeps,
  message: NormalizedMessage,
  binding: ChannelBinding,
  command: Extract<ChannelCommand, { kind: 'approve' }>
): string {
  const { approval } = deps
  if (!approval) return 'Approvals are unavailable: the ledger runtime is off.'
  const id = command.approvalId
  let current: ApprovalSummary | null
  try {
    current = approval.getApproval(id)
  } catch (err) {
    return `Could not read approval ${id}: ${safeErrorText(err, 'unexpected error')}`
  }
  const refused = checkScope(current, binding, id, 'approve')
  if (refused) return refused
  try {
    approval.decideApproval(id, {
      actor: actorFor(message.userId),
      approve: true,
      digest: command.digest,
      nonce: command.nonce,
    })
  } catch (err) {
    return `Approve failed for ${id}: ${safeErrorText(err, 'unexpected error')}`
  }
  const digestTag = command.digest.slice(0, 12)
  if (!deps.consumeOnApprove) {
    return `Approved ${id} by ${actorFor(message.userId)} (digest ${digestTag}). The control plane executes it once.`
  }
  let consumed: boolean
  try {
    consumed = approval.consumeApproval(id, { digest: command.digest })
  } catch (err) {
    return `Approved ${id}, but consuming it failed: ${safeErrorText(err, 'unexpected error')}`
  }
  return consumed
    ? `Approved and consumed ${id} (digest ${digestTag}).`
    : `Approved ${id}, but it was not consumable (expired or used).`
}

export function handleReject(
  deps: ApprovalDeps,
  message: NormalizedMessage,
  binding: ChannelBinding,
  command: Extract<ChannelCommand, { kind: 'reject' }>
): string {
  const { approval } = deps
  if (!approval) return 'Approvals are unavailable: the ledger runtime is off.'
  const id = command.approvalId
  const challenge = extractRejectChallenge(command.reason)
  if (!challenge) {
    return (
      `Deny needs the digest and nonce from the approval card: ` +
      `/reject ${id} <digest> <nonce> [reason]. Nothing was denied.`
    )
  }
  let current: ApprovalSummary | null
  try {
    current = approval.getApproval(id)
  } catch (err) {
    return `Could not read approval ${id}: ${safeErrorText(err, 'unexpected error')}`
  }
  const refused = checkScope(current, binding, id, 'deny')
  if (refused) return refused
  try {
    approval.decideApproval(id, {
      actor: actorFor(message.userId),
      approve: false,
      digest: challenge.digest,
      nonce: challenge.nonce,
    })
  } catch (err) {
    return `Deny failed for ${id}: ${safeErrorText(err, 'unexpected error')}`
  }
  return `Denied ${id}${challenge.reason ? `: ${challenge.reason}` : ''}. The service wakes with a refusal.`
}
