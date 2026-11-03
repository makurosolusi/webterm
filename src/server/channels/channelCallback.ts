// Approval buttons (`callback_query`): a press becomes the same `decideApproval` call as the typed
// `/approve` and `/reject` commands, reusing their scope and ledger checks. Authority is unchanged:
// a group can never decide, and only a bound private chat with an approver/owner role (and the
// bound user id, when set) can. The digest and nonce never travel in `callback_data` (64-byte
// limit, and the client would be trusted to echo them); the server loads them for the approval id.
import { handleApprove, handleReject } from './channelApprovals'
import type { DispatchOutcome, TelegramDispatchDeps } from './channelDispatch'
import { IdentityRegistry, authorizeCommand, type ChannelBinding } from './identity'
import { safeErrorText } from './safeErrorText'
import type { NormalizedCallback } from './telegram'
import { createLogger } from '../logs'

const log = createLogger('channels.telegram')

/** Bot API limit for `callback_data`. */
export const CALLBACK_DATA_MAX_BYTES = 64
const CALLBACK_RE = /^a:([A-Za-z0-9_-]{1,56}):([yn])$/

/** Server-side lookup of the challenge an approval card was issued with (ledger-backed in production). */
export interface ApprovalChallengePort {
  challengeFor(approvalId: string): { digest: string; nonce: string } | null
}

/** Build `a:<approvalId>:y|n`, or null when the id cannot fit the Bot API limit. */
export function approvalCallbackData(approvalId: string, approve: boolean): string | null {
  const data = `a:${approvalId}:${approve ? 'y' : 'n'}`
  return CALLBACK_RE.test(data) && Buffer.byteLength(data) <= CALLBACK_DATA_MAX_BYTES ? data : null
}

/** Inverse of `approvalCallbackData`; null for anything this module did not issue. */
export function parseApprovalCallback(data: string): { approvalId: string; approve: boolean } | null {
  const match = CALLBACK_RE.exec(data)
  return match ? { approvalId: match[1], approve: match[2] === 'y' } : null
}

/**
 * Exactly-once handling of one button press: claim, authorize, decide, queue a confirmation and
 * (best effort) dismiss the client spinner. `reply` queues the confirmation in the chat outbox.
 */
export async function dispatchTelegramCallback(
  cb: NormalizedCallback,
  deps: TelegramDispatchDeps,
  reply: (text: string) => Promise<string | null>
): Promise<DispatchOutcome> {
  if (!deps.store.claimUpdate(cb.updateId)) {
    deps.audit?.({ kind: 'channel.telegram.command', outcome: 'duplicate', updateId: cb.updateId })
    return { status: 'duplicate', updateId: cb.updateId }
  }
  const audit = (outcome: 'handled' | 'denied', extra: { reason?: string; approvalId?: string; projectId?: string } = {}): void =>
    deps.audit?.({ kind: 'channel.telegram.command', outcome, updateId: cb.updateId, command: 'callback', ...extra })
  try {
    if (cb.isGroup) {
      audit('denied', { reason: 'group_not_allowed' })
      return { status: 'denied', reason: 'group_not_allowed' }
    }
    const binding = deps.store.binding('telegram', cb.chatId)
    if (!binding) {
      audit('denied', { reason: 'unknown_chat' })
      return { status: 'denied', reason: 'unknown_chat' }
    }
    const parsed = parseApprovalCallback(cb.data)
    const challenge = parsed ? deps.challenge?.challengeFor(parsed.approvalId) ?? null : null
    const probe = { kind: 'approve', approvalId: parsed?.approvalId ?? '', digest: '', nonce: '' } as const
    const registry = new IdentityRegistry()
    registry.bind('telegram', cb.chatId, binding)
    const auth = authorizeCommand({ channel: 'telegram', chatId: cb.chatId, userId: cb.userId, isGroup: false }, probe, registry)
    if (!auth.ok) {
      audit('denied', { reason: auth.reason, projectId: binding.projectId })
      await dismiss(deps, cb, 'Not allowed.')
      return { status: 'denied', reason: auth.reason }
    }
    const text = parsed && challenge ? await decide(deps, cb, auth.binding, parsed, challenge) : 'This approval card is no longer valid.'
    const queued = await reply(text)
    await dismiss(deps, cb, text.slice(0, 180))
    audit('handled', { projectId: binding.projectId, ...(parsed ? { approvalId: parsed.approvalId } : {}) })
    return { status: 'handled', command: parsed?.approve === false ? 'reject' : 'approve', reply: queued }
  } catch (err) {
    deps.store.releaseUpdate(cb.updateId)
    deps.audit?.({ kind: 'channel.telegram.command', outcome: 'error', updateId: cb.updateId })
    throw err
  }
}

function decide(
  deps: TelegramDispatchDeps,
  cb: NormalizedCallback,
  binding: ChannelBinding,
  parsed: { approvalId: string; approve: boolean },
  challenge: { digest: string; nonce: string }
): string {
  const message = { ...cb, text: '' }
  return parsed.approve
    ? handleApprove(deps, message, binding, { kind: 'approve', approvalId: parsed.approvalId, ...challenge })
    : handleReject(deps, message, binding, {
        kind: 'reject',
        approvalId: parsed.approvalId,
        reason: `${challenge.digest} ${challenge.nonce} via button`,
      })
}

/** Best effort: the decision is already recorded, so a failed `answerCallbackQuery` only leaves a spinner. */
async function dismiss(deps: TelegramDispatchDeps, cb: NormalizedCallback, text: string): Promise<void> {
  if (!deps.answerCallback) return
  try {
    await deps.answerCallback(cb.callbackId, text)
  } catch (err) {
    log.warn('telegram.send.fail', `telegram answerCallbackQuery failed: ${safeErrorText(err, 'unknown error')}`, { stage: 'callback' })
  }
}
