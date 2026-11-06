// Durable channel state (P5-2/P5-4/P5-6): conversation bindings, the queued reply outbox, and the
// inbound `update_id` dedupe record. One small JSON document, replaced atomically by its backend
// (channelStorePersist.ts): the ledger `channel_store` row in production (F2-g, imported once from
// the legacy channels.json), or that JSON file for node-env tests.
//
// Two rules this file exists to enforce:
//  - FAIL CLOSED. A document that cannot be parsed or does not match the schema throws
//    `ChannelStoreError`; it is never overwritten with defaults. The server disables the channel
//    instead of silently forgetting bindings (which would also forget an unlink).
//  - NO SECRETS. Only ids, roles and queued text live here. Bot tokens and webhook secrets stay in
//    env; error messages carry the store location but never content.
import type { ChannelBinding } from './identity'
import {
  CHANNEL_DEDUPE_LIMIT,
  CHANNEL_DEDUPE_TTL_MS,
  CHANNEL_OUTBOX_LIMIT,
  DEFAULT_FORWARD_AWAY_MINUTES,
  MAX_FORWARD_AWAY_MINUTES,
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
  DEFAULT_FORWARD_AWAY_MINUTES,
  type ChannelStoreState,
  type StoredReply,
} from './channelStoreSchema'

import { DEFAULT_ACCOUNT_ID } from './channelStoreMigrate'
import { PersistError, filePersistence, type ChannelStorePersistence } from './channelStorePersist'
import { recordEgress } from './channelStatus'
import { createLogger } from '../logs'

const log = createLogger('channels')

export { DEFAULT_ACCOUNT_ID, STORE_V1_BACKUP_SUFFIX, type ChannelAccount } from './channelStoreMigrate'

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
 * Store over one persistence backend (a path = the JSON file backend). Constructing it loads the
 * document (or starts empty when absent). A corrupt document throws here, before any request can
 * be served, so the caller can disable the channel.
 */
export class ChannelStore {
  private readonly backend: ChannelStorePersistence
  private readonly clock: () => number
  private readonly ttlMs: number
  private readonly dedupeLimit: number
  private readonly outboxLimit: number
  private state: ChannelStoreState
  /** Replies refused because the outbox was full of pending rows, since this store was opened. */
  private droppedReplies = 0

  constructor(store: string | ChannelStorePersistence, options: ChannelStoreOptions = {}) {
    if (typeof store === 'string' && !store.trim()) throw new ChannelStoreError('read_failed', '<empty>')
    this.backend = typeof store === 'string' ? filePersistence(store) : store
    this.clock = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? CHANNEL_DEDUPE_TTL_MS
    this.dedupeLimit = Math.max(1, options.dedupeLimit ?? CHANNEL_DEDUPE_LIMIT)
    this.outboxLimit = Math.max(1, options.outboxLimit ?? CHANNEL_OUTBOX_LIMIT)
    const loaded = this.load()
    this.state = loaded.state
    // v1 -> v2: keep the original, then persist the migrated document once. A legacy import is
    // persisted the same way, only after it passed the strict parse above.
    if (loaded.migrated) this.guard(() => this.backend.backupV1())
    if (loaded.migrated || this.backend.pendingImport) this.save()
  }

  get storePath(): string {
    return this.backend.location
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      throw new ChannelStoreError(err instanceof PersistError ? err.code : 'write_failed', this.backend.location)
    }
  }

  private load(): { state: ChannelStoreState; migrated: boolean } {
    const raw = this.guard(() => this.backend.read())
    if (raw === null) return { state: freshStoreState(), migrated: false }
    try {
      return parseStoreDocument(raw, this.clock())
    } catch (err) {
      const code = err instanceof StoreCorruptError ? err.code : 'corrupt'
      throw new ChannelStoreError(code, this.backend.location)
    }
  }

  private save(): void {
    this.guard(() => this.backend.write(JSON.stringify(this.state)))
  }

  /** Minutes all browser tabs must be away before agent notices go to Telegram; 0 = off. */
  get forwardAwayMinutes(): number {
    return this.state.forwardAwayMinutes ?? DEFAULT_FORWARD_AWAY_MINUTES
  }

  setForwardAwayMinutes(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_FORWARD_AWAY_MINUTES) {
      throw new Error('channel store: invalid away minutes')
    }
    this.state.forwardAwayMinutes = minutes
    this.save()
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
    // claimUpdate advanced the persisted cursor; roll it back so a restart re-fetches this update
    // instead of skipping it. Over-rewinding is safe: re-fetched later updates hit the dedupe.
    this.state.cursor = Math.max(0, Math.min(this.state.cursor, updateId - 1))
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
      if (this.state.outbox.length >= this.outboxLimit) {
        // Never silent: log it and put it on the egress status so the channel panel shows the backlog.
        this.droppedReplies += 1
        const pending = this.state.outbox.length
        const message = `${input.channel} reply queue full (${pending} pending): reply dropped, ${this.droppedReplies} since start`
        log.warn('channel.outbox_full', message, { channel: input.channel, pending, dropped: this.droppedReplies })
        recordEgress({ ok: false, at: this.clock(), error: message })
        return 'full'
      }
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
    change: { nextAt: number; error?: string; dead?: boolean; chunksDone?: number }
  ): boolean {
    const row = this.state.outbox.find((entry) => entry.key === key)
    if (!row || row.state === 'sent') return false
    row.attempts += 1
    if (change.chunksDone !== undefined && change.chunksDone > 0) row.chunksDone = change.chunksDone
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
