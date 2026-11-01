// Schema + strict validation for the channel store document. Kept apart from the file I/O in
// channelStore.ts so the shape check is a pure function that tests can feed arbitrary JSON.
import { CHANNEL_ROLES, type ChannelBinding, type ChannelRole } from './identity'

export const CHANNEL_STORE_VERSION = 1
export const CHANNEL_STORE_FILE = 'channels.json'
/** Telegram retries for up to 24h; an id older than that can never be redelivered usefully. */
export const CHANNEL_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
export const CHANNEL_DEDUPE_LIMIT = 4096
export const CHANNEL_OUTBOX_LIMIT = 500

export interface StoredReply {
  key: string
  channel: string
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
}

export interface ChannelStoreState {
  version: typeof CHANNEL_STORE_VERSION
  /** `channel:chatId` -> binding. Absence means "unknown chat", which is denied (no auto-enroll). */
  bindings: Record<string, ChannelBinding>
  /** `channel:updateId` -> claim timestamp; the persisted half of exactly-once ingress. */
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
  return { version: CHANNEL_STORE_VERSION, bindings: {}, processed: {}, cursor: 0, outbox: [] }
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
    (lastError !== undefined && typeof lastError !== 'string')
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
    ...(threadId === undefined ? {} : { threadId }),
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/** Strict load: any shape drift is `corrupt`, never a partial accept with defaults merged in. */
export function parseStoreState(raw: string): ChannelStoreState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new StoreCorruptError('corrupt')
  }
  if (!isRecord(parsed)) throw new StoreCorruptError('corrupt')
  if (parsed['version'] !== CHANNEL_STORE_VERSION) {
    throw new StoreCorruptError(typeof parsed['version'] === 'number' ? 'unsupported_version' : 'corrupt')
  }

  const bindings: Record<string, ChannelBinding> = {}
  if (!isRecord(parsed['bindings'])) throw new StoreCorruptError('corrupt')
  for (const [key, value] of Object.entries(parsed['bindings'])) {
    const binding = parseBinding(value)
    const at = key.indexOf(':')
    if (!binding || at <= 0 || at === key.length - 1) throw new StoreCorruptError('corrupt')
    bindings[key] = binding
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
  return { version: CHANNEL_STORE_VERSION, bindings, processed, cursor, outbox }
}
