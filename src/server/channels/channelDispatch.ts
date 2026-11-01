// Telegram ingress dispatcher (P5-4/P5-5): normalize -> parse -> authorize -> act via an injected
// ledger port -> enqueue a reply in the outbox. This module is the only place where a channel
// message becomes an effect, and it never touches the network or the ledger directly.
//
// Consent rules encoded here:
//  - An unbound chat is denied silently; nothing is auto-enrolled from a first message.
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
import {
  handleApprove,
  handleReject,
  type ApprovalSummary,
  type ChannelApprovalPort,
} from './channelApprovals'
import { TELEGRAM_MAX_TEXT, parseTelegramUpdate, type NormalizedMessage } from './telegram'
import { redactSecrets } from './webhook'

export type { ApprovalSummary, ChannelApprovalPort } from './channelApprovals'
export { extractRejectChallenge } from './channelApprovals'

export const TELEGRAM_CHANNEL = 'telegram'

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
  ask(input: { projectId: string; text: string; updateId: number }): Promise<
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
}

export type DispatchOutcome =
  | { status: 'ignored'; reason: 'not_a_message' }
  | { status: 'duplicate'; updateId: number }
  | { status: 'denied'; reason: AuthorizationFailure | 'group_not_allowed' }
  | { status: 'handled'; command: ChannelCommand['kind'] | 'free_text'; reply: string | null }

function registryFor(identity: ChannelMessageIdentity, binding: ChannelBinding): IdentityRegistry {
  const registry = new IdentityRegistry()
  registry.bind(identity.channel, identity.chatId, binding)
  return registry
}

async function replyTo(
  deps: TelegramDispatchDeps,
  message: NormalizedMessage,
  text: string
): Promise<string | null> {
  const clipped = text.slice(0, TELEGRAM_MAX_TEXT)
  const reply: ChannelReply = {
    channel: TELEGRAM_CHANNEL,
    chatId: message.chatId,
    text: clipped,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    dedupeKey: `${TELEGRAM_CHANNEL}:${message.chatId}:${message.updateId}`,
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
    console.warn(`telegram reply enqueue failed: ${safeReplyError(err)}`)
    return null
  }
}

/** Channel errors can embed a bot token from a URL; scrub before any log line. */
function safeReplyError(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : 'outbox unavailable'
  return redactSecrets(text).slice(0, 200)
}

async function renderApprovals(
  deps: TelegramDispatchDeps,
  projectId: string,
  heading: string
): Promise<string> {
  if (!deps.approval) return 'Approvals are unavailable: the ledger runtime is off.'
  let rows: ApprovalSummary[]
  try {
    rows = deps.approval.listApprovals({ projectId, status: 'pending', limit: 5 })
  } catch {
    return 'Could not read approvals. Nothing changed.'
  }
  if (rows.length === 0) return `${heading}: no pending approvals for project ${projectId}.`
  const lines = rows.map((row) => `- ${row.id} ${row.kind ?? 'approval'} exp=${row.expiresAt ?? 'n/a'}`)
  return [`${heading}: ${rows.length} pending approval(s) in project ${projectId}.`, ...lines].join('\n')
}

async function runCommand(
  deps: TelegramDispatchDeps,
  message: NormalizedMessage,
  binding: ChannelBinding,
  command: ChannelCommand
): Promise<string> {
  switch (command.kind) {
    case 'status':
      return renderApprovals(deps, binding.projectId, 'Status')
    case 'inbox':
      return renderApprovals(deps, binding.projectId, 'Inbox')
    case 'approve':
      return handleApprove(deps, message, binding, command)
    case 'reject':
      return handleReject(deps, message, binding, command)
    case 'pause':
    case 'resume':
      return 'Pause and resume are controlled from the webterm UI in v1; this channel does not change project state.'
    case 'task':
      return 'Task detail is not available on this channel in v1. Use /inbox or the webterm UI.'
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
  const binding = deps.store.binding(identity.channel, identity.chatId)
  if (!binding) {
    audit('denied', { reason: 'unknown_chat' })
    return { status: 'denied', reason: 'unknown_chat' }
  }

  const parsed = parseCommand(message.text)
  if (!parsed.ok) {
    if (parsed.code === 'not_a_command' && deps.centralChat) {
      const result = await deps.centralChat.ask({ projectId: binding.projectId, text: message.text, updateId: message.updateId })
      const text = result.ok ? result.text : `Central agent unavailable (${result.code}).`
      const reply = await replyTo(deps, message, text)
      audit('handled', { command: 'free_text', projectId: binding.projectId })
      return { status: 'handled', command: 'free_text', reply }
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
  const message = parseTelegramUpdate(update)
  if (!message) return { status: 'ignored', reason: 'not_a_message' }
  if (!deps.store.claimUpdate(message.updateId)) {
    deps.audit?.({
      kind: 'channel.telegram.command',
      outcome: 'duplicate',
      updateId: message.updateId,
    })
    return { status: 'duplicate', updateId: message.updateId }
  }
  try {
    return await handleClaimed(message, deps)
  } catch (err) {
    deps.store.releaseUpdate(message.updateId)
    deps.audit?.({ kind: 'channel.telegram.command', outcome: 'error', updateId: message.updateId })
    throw err
  }
}
