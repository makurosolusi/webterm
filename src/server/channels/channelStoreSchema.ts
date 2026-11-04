// Schema + strict validation for the channel store document. Kept apart from the file I/O in
// channelStore.ts so the shape check is a pure function that tests can feed arbitrary JSON.
import { APPROVAL_ROLES, CHANNEL_ROLES, type ChannelBinding, type ChannelRole } from './identity'
import { migrateStoreV1, parseAccounts, type ChannelAccount } from './channelStoreMigrate'

export const CHANNEL_STORE_VERSION = 2
/** Last single-account layout; still accepted on read and migrated in memory (see channelStoreMigrate). */
const LEGACY_STORE_VERSION = 1
export const CHANNEL_STORE_FILE = 'channels.json'
/** Telegram retries for up to 24h; an id older than that can never be redelivered usefully. */
export const CHANNEL_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
export const CHANNEL_DEDUPE_LIMIT = 4096
export const CHANNEL_OUTBOX_LIMIT = 500

/** `channel:accountId:chatId`; chat ids never contain `:` so the key splits unambiguously. */
export function bindingKey(channel: string, accountId: string, chatId: string): string {
  return `${channel}:${accountId}:${chatId}`
}

/** Inverse of `bindingKey`; null for a key without all three segments. */
export function splitBindingKey(key: string): { channel: string; accountId: string; chatId: string } | null {
  const first = key.indexOf(':')
  const second = key.indexOf(':', first + 1)
  if (first <= 0 || second <= first + 1 || second === key.length - 1) return null
  return { channel: key.slice(0, first), accountId: key.slice(first + 1, second), chatId: key.slice(second + 1) }
}

export interface StoredReply {
  key: string
  channel: string
  /** Sending bot; absent in rows written before v2 (= `default`). */
  accountId?: string
  chatId: string
  text: string
  threadId?: number
  createdAt: number
  attempts: number
  /** Epoch ms before which the sender must not retry. Absent in v1 rows; normalized to createdAt. */
  nextAt: number
  state: 'pending' | 'sent' | 'dead'
  /** Last scrubbed provider error, for operator diagnosis. Never contains a token. */
  lastError?: string
  /**
   * Chunks of a multi-message reply Telegram already accepted; a retry resumes after them so no
   * chunk is sent twice. Additive optional field (absent = 0), so no store version bump.
   */
  chunksDone?: number
}

export interface ChannelStoreState {
  version: typeof CHANNEL_STORE_VERSION
  /** `accountId` -> account. Additive in v2; the token lives in the secret store, not here. */
  accounts: Record<string, ChannelAccount>
  /** `channel:accountId:chatId` -> binding. Absence means "unknown chat", which is denied (no auto-enroll). */
  bindings: Record<string, ChannelBinding>
  /** `channel:accountId:updateId` -> claim timestamp; the persisted half of exactly-once ingress. */
  processed: Record<string, number>
  /** Highest `update_id` ever claimed, for health/metrics only. Never used as a dedupe test. */
  cursor: number
  outbox: StoredReply[]
}

export class StoreCorruptError extends Error {
  constructor(readonly code: 'corrupt' | 'unsupported_version') {
    super(code)
    this.name = 'StoreCorruptError'
  }
}

export function freshStoreState(): ChannelStoreState {
  return { version: CHANNEL_STORE_VERSION, accounts: {}, bindings: {}, processed: {}, cursor: 0, outbox: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isChannelRole(value: unknown): value is ChannelRole {
  return typeof value === 'string' && (CHANNEL_ROLES as readonly string[]).includes(value)
}

export function parseBinding(value: unknown): ChannelBinding | null {
  if (!isRecord(value)) return null
  const projectId = value['projectId']
  const role = value['role']
  const userId = value['userId']
  if (typeof projectId !== 'string' || !projectId.trim() || !isChannelRole(role)) return null
  if (userId !== undefined && (typeof userId !== 'string' || !userId.trim())) return null
  return { projectId, role, ...(userId === undefined ? {} : { userId }) }
}

/** Telegram group/supergroup ids are negative. Mirrors the bind API's group detection. */
function isGroupChatId(chatId: string): boolean {
  return chatId.startsWith('-')
}

/**
 * Load-time group policy (P5 residual): the bind API refuses an approval role for a group chat, but a
 * hand-edited file can still contain one. Reapply the rule here so it never takes effect: downgrade
 * the role in memory to `operator` (read/operator capability kept, approval removed) instead of
 * dropping the binding, so an operator still sees the chat is bound and can rebind it. The file is
 * not rewritten during load; the next save persists the sanitized value.
 */
export function applyGroupApprovalPolicy(chatId: string, binding: ChannelBinding): ChannelBinding {
  if (!isGroupChatId(chatId) || !APPROVAL_ROLES.includes(binding.role)) return binding
  return { ...binding, role: 'operator' }
}

function parseReply(value: unknown): StoredReply | null {
  if (!isRecord(value)) return null
  const key = value['key']
  const channel = value['channel']
  const chatId = value['chatId']
  const text = value['text']
  const createdAt = value['createdAt']
  const attempts = value['attempts']
  const state = value['state']
  const threadId = value['threadId']
  const nextAt = value['nextAt']
  const lastError = value['lastError']
  const accountId = value['accountId']
  const chunksDone = value['chunksDone']
  const bad =
    typeof key !== 'string' || !key ||
    typeof channel !== 'string' || !channel ||
    typeof chatId !== 'string' || !chatId ||
    typeof text !== 'string' ||
    typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
    typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0 ||
    (state !== 'pending' && state !== 'sent' && state !== 'dead') ||
    (threadId !== undefined && (typeof threadId !== 'number' || !Number.isInteger(threadId))) ||
    (nextAt !== undefined && (typeof nextAt !== 'number' || !Number.isFinite(nextAt))) ||
    (lastError !== undefined && typeof lastError !== 'string') ||
    (accountId !== undefined && (typeof accountId !== 'string' || !accountId)) ||
    (chunksDone !== undefined && (typeof chunksDone !== 'number' || !Number.isInteger(chunksDone) || chunksDone < 0))
  if (bad) return null
  // A v1 row written before the sender existed has no nextAt; it is immediately due. This is the
  // only in-memory migration, and every other field still passes the strict shape check.
  return {
    key,
    channel,
    chatId,
    text,
    createdAt,
    attempts,
    nextAt: nextAt === undefined ? createdAt : nextAt,
    state,
    ...(accountId === undefined ? {} : { accountId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(chunksDone === undefined ? {} : { chunksDone }),
  }
}

/** Strict load; a v1 file is migrated in memory first (`migrated`), the caller persists it with a backup. */
export function parseStoreDocument(raw: string, now: number = Date.now()): { state: ChannelStoreState; migrated: boolean } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new StoreCorruptError('corrupt')
  }
  if (!isRecord(json)) throw new StoreCorruptError('corrupt')
  const migrated = json['version'] === LEGACY_STORE_VERSION
  const parsed = migrated ? migrateStoreV1(json, now) : json
  if (parsed['version'] !== CHANNEL_STORE_VERSION) {
    throw new StoreCorruptError(typeof parsed['version'] === 'number' ? 'unsupported_version' : 'corrupt')
  }
  const accounts = parseAccounts(parsed['accounts'])
  if (!accounts) throw new StoreCorruptError('corrupt')

  const bindings: Record<string, ChannelBinding> = {}
  if (!isRecord(parsed['bindings'])) throw new StoreCorruptError('corrupt')
  for (const [key, value] of Object.entries(parsed['bindings'])) {
    const binding = parseBinding(value)
    const parts = splitBindingKey(key)
    if (!binding || !parts) throw new StoreCorruptError('corrupt')
    bindings[key] = applyGroupApprovalPolicy(parts.chatId, binding)
  }

  const processed: Record<string, number> = {}
  if (!isRecord(parsed['processed'])) throw new StoreCorruptError('corrupt')
  for (const [key, value] of Object.entries(parsed['processed'])) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new StoreCorruptError('corrupt')
    processed[key] = value
  }

  const cursor = parsed['cursor']
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
    throw new StoreCorruptError('corrupt')
  }

  const outbox: StoredReply[] = []
  if (!Array.isArray(parsed['outbox'])) throw new StoreCorruptError('corrupt')
  for (const value of parsed['outbox']) {
    const reply = parseReply(value)
    if (!reply) throw new StoreCorruptError('corrupt')
    outbox.push(reply)
  }
  return { state: { version: CHANNEL_STORE_VERSION, accounts, bindings, processed, cursor, outbox }, migrated }
}

/** Strict load: any shape drift is `corrupt`, never a partial accept with defaults merged in. */
export function parseStoreState(raw: string, now?: number): ChannelStoreState {
  return parseStoreDocument(raw, now).state
}
