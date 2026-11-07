// Telegram ingress dispatcher (P5-4/P5-5): normalize -> parse -> authorize -> act via an injected
// ledger port -> enqueue a reply in the outbox. This module is the only place where a channel
// message becomes an effect, and it never touches the network or the ledger directly.
//
// Consent rules encoded here:
//  - An unbound chat is denied silently; nothing is auto-enrolled from a first message. The one
//    exception is `/start <code>` carrying a live one-time pairing code the owner issued from the
//    Settings card (telegramPairing.ts): the code IS the owner's consent, so that chat is bound.
//  - Group chats are denied outright: identity is ambiguous and a group mirror must not mutate.
//  - `/approve` needs approvalId + digest + nonce from the ledger challenge; a bare "yes" is text.
//  - The ledger decides digest/nonce/expiry/state; this file never re-implements those checks.
import {
  COMMAND_USAGE,
  IdentityRegistry,
  authorizeCommand,
  parseCommand,
  type AuthorizationFailure,
  type ChannelBinding,
  type ChannelCommand,
  type ChannelMessageIdentity,
} from './identity'
import type { ChannelApprovalPort } from './channelApprovals'
import { runCommand } from './channelCommands'
import type { WorldCountsPort } from './channelWorld'
import { isCallbackUpdate, parseTelegramCallback, parseTelegramUpdate, type NormalizedMessage } from './telegram'
import { dispatchTelegramCallback, type ApprovalChallengePort } from './channelCallback'
import { safeErrorText } from './safeErrorText'
import type { PendingChatPort } from './channelPending'
import { pairFromStart } from './telegramPairingDispatch'
import { maskChatId } from './telegramEgressLog'
import { createLogger } from '../logs'

const log = createLogger('channels.telegram')

export type { ApprovalSummary, ChannelApprovalPort } from './channelApprovals'
export { extractRejectChallenge } from './channelApprovals'

export const TELEGRAM_CHANNEL = 'telegram'
/**
 * Upper bound for one queued reply. The sender splits it into <=4096-char Telegram messages
 * (`telegramMarkdownChunks`); this cap only stops a runaway reply from flooding the chat (~8 msgs).
 */
export const CHANNEL_REPLY_MAX_CHARS = 32_000
export const CHANNEL_REPLY_CLIPPED_SUFFIX = '\n\n… (truncated)'
export const CENTRAL_QUEUED_REPLY = 'Queued: Central is busy with another message. I will answer right after it.'

export interface ChannelReply {
  channel: string
  chatId: string
  text: string
  threadId?: number
  dedupeKey: string
}

/** The slice of ChannelStore the dispatcher needs; tests pass a fake. */
export interface ChannelStorePort {
  binding(channel: string, chatId: string): ChannelBinding | undefined
  /** Needed only for deep-link pairing; without it `/start <code>` is treated like any message. */
  bind?(channel: string, chatId: string, binding: ChannelBinding): void
  claimUpdate(updateId: number, channel?: string): boolean
  releaseUpdate(updateId: number, channel?: string): void
  enqueueReply(input: {
    key: string
    channel: string
    chatId: string
    text: string
    threadId?: number
  }): 'queued' | 'duplicate' | 'full'
}

export interface TelegramCentralPort {
  ask(input: { projectId: string; text: string; updateId: number; onQueued?: () => void }): Promise<
    { ok: true; text: string } | { ok: false; code: string }
  >
}

export interface ChannelAuditEvent {
  kind: 'channel.telegram.command'
  outcome: 'handled' | 'denied' | 'replied' | 'duplicate' | 'error'
  updateId: number
  command?: string
  reason?: string
  projectId?: string
  approvalId?: string
}

export interface TelegramDispatchDeps {
  store: ChannelStorePort
  approval?: ChannelApprovalPort
  /** Replaces the store outbox when supplied (tests, or a different queue implementation). */
  enqueue?: (reply: ChannelReply) => void | Promise<void>
  /** See `ApprovalDeps.consumeOnApprove`: off unless the channel is the executor. */
  consumeOnApprove?: boolean
  audit?: (event: ChannelAuditEvent) => void
  centralChat?: TelegramCentralPort
  /** Where denied unknown private chats are listed for the owner (never replied to). */
  pending?: PendingChatPort
  /** Enables approval buttons; without it a `callback_query` is ignored (pre-v2 behavior). */
  challenge?: ApprovalChallengePort
  /** Dismisses the client spinner after a button press (Bot API `answerCallbackQuery`). */
  answerCallback?: (callbackId: string, text: string) => Promise<void>
  /** World-view counts shown by `/status` (same numbers as the canvas); omitted = no counts line. */
  world?: WorldCountsPort
  /** Receives the detached central turn so tests or shutdown can await it; the turn never rejects. */
  background?: (task: Promise<void>) => void
}

export type DispatchOutcome =
  | { status: 'ignored'; reason: 'not_a_message' }
  | { status: 'duplicate'; updateId: number }
  | { status: 'denied'; reason: AuthorizationFailure | 'group_not_allowed' }
  | { status: 'handled'; command: ChannelCommand['kind'] | 'free_text' | 'pair'; reply: string | null }

function registryFor(identity: ChannelMessageIdentity, binding: ChannelBinding): IdentityRegistry {
  const registry = new IdentityRegistry()
  registry.bind(identity.channel, identity.chatId, binding)
  return registry
}

async function replyTo(deps: TelegramDispatchDeps, message: NormalizedMessage, text: string, keySuffix = ''): Promise<string | null> {
  const clipped = text.length <= CHANNEL_REPLY_MAX_CHARS
    ? text
    : text.slice(0, CHANNEL_REPLY_MAX_CHARS - CHANNEL_REPLY_CLIPPED_SUFFIX.length) + CHANNEL_REPLY_CLIPPED_SUFFIX
  const reply: ChannelReply = {
    channel: TELEGRAM_CHANNEL,
    chatId: message.chatId,
    text: clipped,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    dedupeKey: `${TELEGRAM_CHANNEL}:${message.chatId}:${message.updateId}${keySuffix}`,
  }
  try {
    if (deps.enqueue) {
      await deps.enqueue(reply)
      return clipped
    }
    const outcome = deps.store.enqueueReply({
      key: reply.dedupeKey,
      channel: reply.channel,
      chatId: reply.chatId,
      text: reply.text,
      ...(reply.threadId === undefined ? {} : { threadId: reply.threadId }),
    })
    return outcome === 'full' ? null : clipped
  } catch (err) {
    // The reply is already an after-effect: by the time we enqueue, the command (including a ledger
    // decision) has been applied. A disk-full outbox must therefore not fail the dispatch — that
    // would release the update claim and let the provider retry re-run the whole command.
    log.warn('telegram.send.fail', `telegram reply enqueue failed: ${safeErrorText(err, 'outbox unavailable')}`, { stage: 'enqueue' })
    return null
  }
}

/** Best-effort: a pending-list failure must never change the (silent) denial or slow the update. */
function recordPending(deps: TelegramDispatchDeps, chatId: string): void {
  try {
    deps.pending?.record(chatId, 'private') // groups were denied earlier, so only private reaches here
  } catch (err) {
    log.warn('channel.dispatch', `telegram pending record failed: ${safeErrorText(err, 'outbox unavailable')}`, { stage: 'pending' })
  }
}

/** Detached central turn: always resolves; a failed turn is reported to the chat, never thrown. */
async function runCentralTurn(
  deps: TelegramDispatchDeps,
  central: TelegramCentralPort,
  message: NormalizedMessage,
  projectId: string
): Promise<void> {
  try {
    const onQueued = (): void => void replyTo(deps, message, CENTRAL_QUEUED_REPLY, ':queued')
    const result = await central.ask({ projectId, text: message.text, updateId: message.updateId, onQueued })
    await replyTo(deps, message, result.ok ? result.text : `Central agent unavailable (${result.code}).`)
  } catch (err) {
    log.error('channel.dispatch', 'telegram central turn failed', { updateId: message.updateId, error: safeErrorText(err, 'unknown error') })
  }
}

async function handleClaimed(
  message: NormalizedMessage,
  deps: TelegramDispatchDeps
): Promise<DispatchOutcome> {
  const identity: ChannelMessageIdentity = {
    channel: TELEGRAM_CHANNEL,
    chatId: message.chatId,
    userId: message.userId,
    isGroup: message.isGroup,
  }
  const audit = (outcome: ChannelAuditEvent['outcome'], extra: Partial<ChannelAuditEvent> = {}): void => {
    deps.audit?.({ kind: 'channel.telegram.command', outcome, updateId: message.updateId, ...extra })
  }

  if (identity.isGroup) {
    audit('denied', { reason: 'group_not_allowed' })
    return { status: 'denied', reason: 'group_not_allowed' }
  }
  const paired = await pairFromStart(deps, message, (text) => replyTo(deps, message, text))
  if (paired) return paired
  const binding = deps.store.binding(identity.channel, identity.chatId)
  if (!binding) {
    recordPending(deps, identity.chatId)
    audit('denied', { reason: 'unknown_chat' })
    return { status: 'denied', reason: 'unknown_chat' }
  }

  const parsed = parseCommand(message.text)
  if (!parsed.ok) {
    if (parsed.code === 'not_a_command' && deps.centralChat) {
      // B7: the turn can take minutes; the claim is already durable, so ack now and reply via the outbox.
      const task = runCentralTurn(deps, deps.centralChat, message, binding.projectId)
      if (deps.background) deps.background(task)
      audit('handled', { command: 'free_text', projectId: binding.projectId })
      return { status: 'handled', command: 'free_text', reply: null }
    }
    const text = parsed.code === 'empty' ? COMMAND_USAGE : parsed.message
    const reply = await replyTo(deps, message, text)
    audit('replied', { reason: parsed.code })
    return { status: 'handled', command: 'free_text', reply }
  }

  const command = parsed.command
  const auth = authorizeCommand(identity, command, registryFor(identity, binding))
  if (!auth.ok) {
    audit('denied', { reason: auth.reason, command: command.kind, projectId: binding.projectId })
    return { status: 'denied', reason: auth.reason }
  }

  const text = await runCommand(deps, message, auth.binding, command)
  const reply = await replyTo(deps, message, text)
  audit('handled', {
    command: command.kind,
    projectId: binding.projectId,
    ...(command.kind === 'approve' || command.kind === 'reject'
      ? { approvalId: command.approvalId }
      : {}),
  })
  return { status: 'handled', command: command.kind, reply }
}

/**
 * Exactly-once ingress. The claim is persisted before any effect; on a replay the effect is
 * skipped. An unexpected failure releases the claim so Telegram's retry can be served.
 */
export async function dispatchTelegramUpdate(
  update: unknown,
  deps: TelegramDispatchDeps
): Promise<DispatchOutcome> {
  if (isCallbackUpdate(update)) {
    const cb = deps.challenge ? parseTelegramCallback(update) : null
    if (!cb) return { status: 'ignored', reason: 'not_a_message' }
    return dispatchTelegramCallback(cb, deps, (text) => replyTo(deps, { ...cb, text: '' }, text))
  }
  const message = parseTelegramUpdate(update)
  if (!message) {
    log.debug('telegram.update.recv', 'telegram update ignored (not a message)', { type: 'other' })
    return { status: 'ignored', reason: 'not_a_message' }
  }
  log.debug('telegram.update.recv', 'telegram update received', {
    type: 'message',
    updateId: message.updateId,
    chat: maskChatId(message.chatId),
    isGroup: message.isGroup,
  })
  if (!deps.store.claimUpdate(message.updateId)) {
    log.debug('channel.dispatch', 'telegram dispatch duplicate', { updateId: message.updateId, status: 'duplicate' })
    deps.audit?.({
      kind: 'channel.telegram.command',
      outcome: 'duplicate',
      updateId: message.updateId,
    })
    return { status: 'duplicate', updateId: message.updateId }
  }
  try {
    const outcome = await handleClaimed(message, deps)
    log.info('channel.dispatch', `telegram dispatch ${outcome.status}`, {
      updateId: message.updateId,
      status: outcome.status,
      ...(outcome.status === 'handled' ? { command: outcome.command } : {}),
      ...(outcome.status === 'denied' ? { reason: outcome.reason } : {}),
    })
    return outcome
  } catch (err) {
    log.error('channel.dispatch', 'telegram dispatch failed', { updateId: message.updateId, error: safeErrorText(err, 'unknown error') })
    deps.store.releaseUpdate(message.updateId)
    deps.audit?.({ kind: 'channel.telegram.command', outcome: 'error', updateId: message.updateId })
    throw err
  }
}
