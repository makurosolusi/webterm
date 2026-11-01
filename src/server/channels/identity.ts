// Channel identity + command grammar (O4/O5/O7/O8). A channel message is only meaningful when its
// conversation is explicitly bound from the web UI; nothing here auto-enrolls a sender. The command
// grammar is deterministic and lives next to the authorization rules because every parsed command is
// checked against the same binding, and free text is never consent.
export type ChannelRole = 'viewer' | 'operator' | 'approver' | 'owner'

export const CHANNEL_ROLES: readonly ChannelRole[] = ['viewer', 'operator', 'approver', 'owner']
export const APPROVAL_ROLES: readonly ChannelRole[] = ['approver', 'owner']

export interface ChannelBinding {
  projectId: string
  role: ChannelRole
  /** Numeric provider user id that owns this binding. Mismatch is denied, not re-bound. */
  userId?: string
}

export interface ChannelMessageIdentity {
  channel: string
  chatId: string
  userId: string
  isGroup: boolean
}

export type AuthorizationFailure =
  | 'unknown_chat'
  | 'user_mismatch'
  | 'group_not_allowed'
  | 'role_denied'

export type AuthorizeResult =
  | { ok: true; binding: ChannelBinding }
  | { ok: false; reason: AuthorizationFailure }

export function conversationKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`
}

function isRole(value: unknown): value is ChannelRole {
  return typeof value === 'string' && (CHANNEL_ROLES as readonly string[]).includes(value)
}

/** Explicit binding table. Group chats may bind read-only roles but can never approve. */
export class IdentityRegistry {
  private readonly bindings = new Map<string, ChannelBinding>()

  /** Bind (or re-bind) one conversation. Throws on invalid input instead of silently storing it. */
  bind(channel: string, chatId: string, binding: ChannelBinding): void {
    if (!channel.trim() || !chatId.trim()) throw new Error('identity: channel and chatId are required')
    if (!binding.projectId.trim()) throw new Error('identity: projectId is required')
    if (!isRole(binding.role)) throw new Error(`identity: unknown role ${String(binding.role)}`)
    this.bindings.set(conversationKey(channel, chatId), { ...binding })
  }

  resolve(channel: string, chatId: string): ChannelBinding | undefined {
    return this.bindings.get(conversationKey(channel, chatId))
  }

  unbind(channel: string, chatId: string): boolean {
    return this.bindings.delete(conversationKey(channel, chatId))
  }

  size(): number {
    return this.bindings.size
  }
}

/**
 * Gate a parsed command against the conversation binding.
 * - unknown chat -> rejected (no auto-enroll)
 * - bound user id that differs from the sender -> rejected
 * - approve/reject from a group -> rejected (identity is ambiguous in groups)
 * - approve/reject without an approver/owner role -> rejected
 */
export function authorizeCommand(
  identity: ChannelMessageIdentity,
  command: ChannelCommand,
  registry: IdentityRegistry
): AuthorizeResult {
  const binding = registry.resolve(identity.channel, identity.chatId)
  if (!binding) return { ok: false, reason: 'unknown_chat' }
  if (binding.userId !== undefined && binding.userId !== identity.userId) {
    return { ok: false, reason: 'user_mismatch' }
  }
  if (command.kind === 'approve' || command.kind === 'reject') {
    if (identity.isGroup) return { ok: false, reason: 'group_not_allowed' }
    if (!APPROVAL_ROLES.includes(binding.role)) return { ok: false, reason: 'role_denied' }
  }
  return { ok: true, binding }
}

// --- Command grammar -------------------------------------------------------------------------

export const MAX_COMMAND_CHARS = 512

export type ChannelCommand =
  | { kind: 'status'; project?: string }
  | { kind: 'inbox' }
  | { kind: 'task'; taskId: string }
  | { kind: 'approve'; approvalId: string; digest: string; nonce: string }
  | { kind: 'reject'; approvalId: string; reason?: string }
  | { kind: 'pause'; project?: string }
  | { kind: 'resume'; project?: string }

export type CommandErrorCode =
  | 'empty'
  | 'too_long'
  | 'not_a_command'
  | 'unknown_command'
  | 'usage'

export type CommandParseResult =
  | { ok: true; command: ChannelCommand }
  | { ok: false; code: CommandErrorCode; message: string }

export const COMMAND_USAGE =
  'Commands: /status [project] | /inbox | /task <id> | /approve <id> <digest> <nonce> | ' +
  '/reject <id> [reason] | /pause [project] | /resume [project]'

/** Bare consent vocabulary. It is never an approval; callers must reply with usage instead. */
const CONSENT_WORDS = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'go',
  'go ahead',
  'proceed',
  'do it',
])

export function isBareConsent(text: string): boolean {
  return CONSENT_WORDS.has(text.trim().toLowerCase().replace(/[.!]+$/, ''))
}

function fail(code: CommandErrorCode, message: string): CommandParseResult {
  return { ok: false, code, message }
}

/** Accept `/status` and group form `/status@SomeBot`; the suffix is transport noise, not authz. */
function normalizeVerb(raw: string): string {
  const at = raw.indexOf('@')
  return (at === -1 ? raw : raw.slice(0, at)).toLowerCase()
}

function singleArg(rest: string[]): string | undefined | null {
  if (rest.length === 0) return undefined
  if (rest.length > 1) return null
  return rest[0]
}

/** Deterministic parse. Unknown input yields a usage/help error, never a guess or an execution. */
export function parseCommand(text: string): CommandParseResult {
  const raw = text.trim()
  if (!raw) return fail('empty', 'No command. Try /status.')
  if (raw.length > MAX_COMMAND_CHARS) return fail('too_long', `Command exceeds ${MAX_COMMAND_CHARS} characters.`)
  if (!raw.startsWith('/')) {
    if (isBareConsent(raw)) {
      return fail(
        'not_a_command',
        'Text is not consent. Use /approve <id> <digest> <nonce> with the values from the approval card.'
      )
    }
    return fail('not_a_command', 'Messages become proposals; use /status or /inbox to see commands.')
  }

  const [verbPart, ...rest] = raw.slice(1).split(/\s+/)
  const verb = normalizeVerb(verbPart ?? '')

  switch (verb) {
    case 'status':
    case 'pause':
    case 'resume': {
      const project = singleArg(rest)
      if (project === null) return fail('usage', `Usage: /${verb} [project]`)
      return { ok: true, command: { kind: verb, ...(project ? { project } : {}) } }
    }
    case 'inbox':
      if (rest.length > 0) return fail('usage', 'Usage: /inbox')
      return { ok: true, command: { kind: 'inbox' } }
    case 'task': {
      if (rest.length !== 1) return fail('usage', 'Usage: /task <id>')
      return { ok: true, command: { kind: 'task', taskId: rest[0] } }
    }
    case 'approve': {
      if (rest.length !== 3) return fail('usage', 'Usage: /approve <approvalId> <digest> <nonce>')
      const [approvalId, digest, nonce] = rest
      if (approvalId.length > 128 || digest.length > 128 || nonce.length > 128) {
        return fail('usage', 'Approval values are too long.')
      }
      return { ok: true, command: { kind: 'approve', approvalId, digest, nonce } }
    }
    case 'reject': {
      if (rest.length < 1) return fail('usage', 'Usage: /reject <approvalId> [reason]')
      const [approvalId, ...reasonParts] = rest
      if (approvalId.length > 128) return fail('usage', 'Approval id is too long.')
      const reason = reasonParts.join(' ')
      return { ok: true, command: { kind: 'reject', approvalId, ...(reason ? { reason } : {}) } }
    }
    case 'help':
      return fail('unknown_command', COMMAND_USAGE)
    default:
      return fail('unknown_command', `Unknown command /${verb}. ${COMMAND_USAGE}`)
  }
}
