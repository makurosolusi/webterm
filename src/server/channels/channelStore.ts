// Durable channel state (P5-2/P5-4/P5-6): conversation bindings, the queued reply outbox, and the
// inbound `update_id` dedupe record. One small JSON document, written atomically (tmp + rename,
// mode 0600, directory 0700) so a crash can never leave a half-written file that a later boot
// would treat as truth.
//
// Two rules this file exists to enforce:
//  - FAIL CLOSED. A file that cannot be parsed or does not match the schema throws
//    `ChannelStoreError`; it is never overwritten with defaults. The server disables the channel
//    instead of silently forgetting bindings (which would also forget an unlink).
//  - NO SECRETS. Only ids, roles and queued text live here. Bot tokens and webhook secrets stay in
//    env; error messages carry the store path but never file content.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChannelBinding } from './identity'
import {
  CHANNEL_DEDUPE_LIMIT,
  CHANNEL_DEDUPE_TTL_MS,
  CHANNEL_OUTBOX_LIMIT,
  StoreCorruptError,
  bindingKey,
  freshStoreState,
  parseBinding,
  parseStoreDocument,
  splitBindingKey,
  type ChannelStoreState,
  type StoredReply,
} from './channelStoreSchema'

export {
  CHANNEL_DEDUPE_LIMIT,
  CHANNEL_DEDUPE_TTL_MS,
  CHANNEL_OUTBOX_LIMIT,
  CHANNEL_STORE_FILE,
  CHANNEL_STORE_VERSION,
  type ChannelStoreState,
  type StoredReply,
} from './channelStoreSchema'

import { DEFAULT_ACCOUNT_ID, backupStoreV1 } from './channelStoreMigrate'

export { DEFAULT_ACCOUNT_ID, STORE_V1_BACKUP_SUFFIX, type ChannelAccount } from './channelStoreMigrate'

const MAX_STORE_BYTES = 4 * 1024 * 1024

export type ChannelStoreErrorCode = 'corrupt' | 'unsupported_version' | 'read_failed' | 'write_failed'

/** Deliberately content-free: only the reason code and the path. Safe to log verbatim. */
export class ChannelStoreError extends Error {
  constructor(readonly code: ChannelStoreErrorCode, readonly storePath: string) {
    super(`channel store ${code}: ${storePath}`)
    this.name = 'ChannelStoreError'
  }
}

export interface EnqueueReplyInput {
  key: string
  channel: string
  /** Sending bot; omitted = `default`. */
  accountId?: string
  chatId: string
  text: string
  threadId?: number
}
export type EnqueueReplyOutcome = 'queued' | 'duplicate' | 'full'

export interface ChannelStoreOptions {
  now?: () => number
  ttlMs?: number
  dedupeLimit?: number
  outboxLimit?: number
}

/**
 * File-backed store. Constructing it loads the file (or starts empty when absent). A corrupt file
 * throws here, before any request can be served, so the caller can disable the channel.
 */
export class ChannelStore {
  private readonly path: string
  private readonly clock: () => number
  private readonly ttlMs: number
  private readonly dedupeLimit: number
  private readonly outboxLimit: number
  private state: ChannelStoreState

  constructor(storePath: string, options: ChannelStoreOptions = {}) {
    if (!storePath.trim()) throw new ChannelStoreError('read_failed', '<empty>')
    this.path = storePath
    this.clock = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? CHANNEL_DEDUPE_TTL_MS
    this.dedupeLimit = Math.max(1, options.dedupeLimit ?? CHANNEL_DEDUPE_LIMIT)
    this.outboxLimit = Math.max(1, options.outboxLimit ?? CHANNEL_OUTBOX_LIMIT)
    const loaded = this.load()
    this.state = loaded.state
    // v1 -> v2: keep the original next to the file, then persist the migrated document once.
    if (loaded.migrated) {
      try {
        backupStoreV1(this.path)
      } catch {
        throw new ChannelStoreError('write_failed', this.path)
      }
      this.save()
    }
  }

  get storePath(): string {
    return this.path
  }

  private load(): { state: ChannelStoreState; migrated: boolean } {
    if (!existsSync(this.path)) {
      this.ensureDir()
      return { state: freshStoreState(), migrated: false }
    }
    let raw: string
    try {
      if (statSync(this.path).size > MAX_STORE_BYTES) throw new Error('too_large')
      raw = readFileSync(this.path, 'utf8')
    } catch {
      throw new ChannelStoreError('read_failed', this.path)
    }
    try {
      return parseStoreDocument(raw, this.clock())
    } catch (err) {
      const code = err instanceof StoreCorruptError ? err.code : 'corrupt'
      throw new ChannelStoreError(code, this.path)
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.path)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // mkdir's mode is filtered by umask, so assert the final mode explicitly.
      if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
    } catch {
      throw new ChannelStoreError('write_failed', this.path)
    }
  }

  /** Atomic write: fsync tmp, rename over the target, then force 0600 on the final file. */
  private save(): void {
    this.ensureDir()
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'wx', 0o600)
      writeSync(fd, JSON.stringify(this.state))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmp, this.path)
      chmodSync(this.path, 0o600)
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // fd was already closed by the failure path; nothing to recover.
        }
      }
      try {
        unlinkSync(tmp)
      } catch {
        // tmp was never created or was already renamed; nothing to clean up.
      }
      throw new ChannelStoreError('write_failed', this.path)
    }
  }

  snapshot(): ChannelStoreState {
    return JSON.parse(JSON.stringify(this.state)) as ChannelStoreState
  }

  binding(channel: string, chatId: string, accountId = DEFAULT_ACCOUNT_ID): ChannelBinding | undefined {
    const found = this.state.bindings[bindingKey(channel, accountId, chatId)]
    return found ? { ...found } : undefined
  }

  bind(channel: string, chatId: string, binding: ChannelBinding, accountId = DEFAULT_ACCOUNT_ID): void {
    if (!channel.trim() || !chatId.trim()) throw new Error('channel store: channel and chatId are required')
    const parsed = parseBinding(binding)
    if (!parsed) throw new Error('channel store: invalid binding')
    this.state.bindings[bindingKey(channel, accountId, chatId)] = parsed
    this.save()
  }

  unbind(channel: string, chatId: string, accountId = DEFAULT_ACCOUNT_ID): boolean {
    const key = bindingKey(channel, accountId, chatId)
    if (!(key in this.state.bindings)) return false
    delete this.state.bindings[key]
    this.save()
    return true
  }

  /**
   * Persist the claim BEFORE any effect; `false` means a replay, and the caller must skip the
   * effect entirely. `releaseUpdate` rolls the claim back when the effect failed, so a provider
   * retry can still be served. Never twice: a crash between claim and effect drops, not duplicates.
   */
  claimUpdate(updateId: number, channel = 'telegram', accountId = DEFAULT_ACCOUNT_ID): boolean {
    if (!Number.isInteger(updateId) || updateId < 0) throw new Error('channel store: invalid update id')
    this.pruneProcessed()
    const key = bindingKey(channel, accountId, String(updateId))
    if (key in this.state.processed) return false
    this.state.processed[key] = this.clock()
    this.state.cursor = Math.max(this.state.cursor, updateId)
    this.pruneProcessed()
    this.save()
    return true
  }

  releaseUpdate(updateId: number, channel = 'telegram', accountId = DEFAULT_ACCOUNT_ID): void {
    const key = bindingKey(channel, accountId, String(updateId))
    if (!(key in this.state.processed)) return
    delete this.state.processed[key]
    this.save()
  }

  enqueueReply(input: EnqueueReplyInput): EnqueueReplyOutcome {
    if (!input.key.trim() || !input.channel.trim() || !input.chatId.trim()) {
      throw new Error('channel store: key, channel and chatId are required')
    }
    if (this.state.outbox.some((row) => row.key === input.key)) return 'duplicate'
    if (this.state.outbox.length >= this.outboxLimit) {
      // Sent and dead rows are reclaimable; pending rows are never silently dropped.
      this.state.outbox = this.state.outbox.filter((row) => row.state === 'pending')
      if (this.state.outbox.length >= this.outboxLimit) return 'full'
    }
    this.state.outbox.push({
      key: input.key,
      channel: input.channel,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      chatId: input.chatId,
      text: input.text,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      createdAt: this.clock(),
      attempts: 0,
      nextAt: this.clock(),
      state: 'pending',
    })
    this.save()
    return 'queued'
  }

  pendingReplies(): StoredReply[] {
    return this.state.outbox.filter((row) => row.state === 'pending').map((row) => ({ ...row }))
  }

  markReplySent(key: string): boolean {
    const row = this.state.outbox.find((entry) => entry.key === key)
    if (!row || row.state === 'sent') return false
    row.state = 'sent'
    row.nextAt = this.clock()
    row.lastError = undefined
    this.save()
    return true
  }

  /**
   * Record one send failure. Attempts and nextAt are persisted so a restart keeps its backoff
   * promise; `dead` stops the sender from retrying a permanently rejected reply. The caller owns
   * the (already scrubbed) error text.
   */
  markReplyFailed(
    key: string,
    change: { nextAt: number; error?: string; dead?: boolean }
  ): boolean {
    const row = this.state.outbox.find((entry) => entry.key === key)
    if (!row || row.state === 'sent') return false
    row.attempts += 1
    row.nextAt = Number.isFinite(change.nextAt) ? change.nextAt : this.clock()
    row.state = change.dead ? 'dead' : 'pending'
    row.lastError = change.error ? change.error.slice(0, 300) : undefined
    this.save()
    return true
  }

  /** Explicit bindings of one account (default: `default`) for the human API, in insertion order. */
  listBindings(
    channel?: string,
    accountId = DEFAULT_ACCOUNT_ID
  ): Array<{ channel: string; chatId: string; binding: ChannelBinding }> {
    const out: Array<{ channel: string; chatId: string; binding: ChannelBinding }> = []
    for (const [key, binding] of Object.entries(this.state.bindings)) {
      const parts = splitBindingKey(key)
      if (!parts || parts.accountId !== accountId) continue
      if (channel !== undefined && parts.channel !== channel) continue
      out.push({ channel: parts.channel, chatId: parts.chatId, binding: { ...binding } })
    }
    return out
  }

  /** Drop dedupe keys past TTL, oldest first, then enforce the hard bound. */
  private pruneProcessed(): void {
    const cutoff = this.clock() - this.ttlMs
    for (const [key, at] of Object.entries(this.state.processed)) {
      if (at <= cutoff) delete this.state.processed[key]
    }
    const keys = Object.keys(this.state.processed)
    if (keys.length <= this.dedupeLimit) return
    keys
      .sort((a, b) => this.state.processed[a] - this.state.processed[b])
      .slice(0, keys.length - this.dedupeLimit)
      .forEach((key) => delete this.state.processed[key])
  }
}
