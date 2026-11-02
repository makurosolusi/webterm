// "Pending" chats: private Telegram chats that messaged the bot but have no binding. They are still
// denied silently (no reply, so the bot's existence is not confirmed to strangers); this list only
// lets the owner see them and bind with one click. Stored in memory ON PURPOSE: strangers control
// the write rate, so nothing here touches disk, and a restart merely forgets entries that reappear
// on the sender's next message. It holds no message text, name or username: only the chat id.
export const PENDING_CHAT_LIMIT = 100
export const PENDING_CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export type PendingChatType = 'private'

export interface PendingChat {
  chatId: string
  type: PendingChatType
  firstSeen: number
  lastSeen: number
  count: number
}

/** The slice the dispatcher needs; recording must never throw into ingress. */
export interface PendingChatPort {
  record(chatId: string, type: PendingChatType): void
}

export interface PendingChatOptions {
  now?: () => number
  limit?: number
  ttlMs?: number
}

/** Bounded, deduped (per chat id) pending list. Map order == lastSeen order, oldest first. */
export class PendingChatStore implements PendingChatPort {
  private readonly rows = new Map<string, PendingChat>()
  private readonly clock: () => number
  private readonly limit: number
  private readonly ttlMs: number

  constructor(options: PendingChatOptions = {}) {
    this.clock = options.now ?? Date.now
    this.limit = Math.max(1, options.limit ?? PENDING_CHAT_LIMIT)
    this.ttlMs = options.ttlMs ?? PENDING_CHAT_TTL_MS
  }

  /** Upsert one chat: first sight creates it, later sights bump `count` and `lastSeen`. */
  record(chatId: string, type: PendingChatType): void {
    const now = this.clock()
    this.expire(now)
    const prev = this.rows.get(chatId)
    this.rows.delete(chatId) // re-insert at the tail so the oldest-lastSeen entry stays first
    this.rows.set(chatId, {
      chatId,
      type,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      count: (prev?.count ?? 0) + 1,
    })
    while (this.rows.size > this.limit) {
      const oldest = this.rows.keys().next().value
      if (oldest === undefined) break
      this.rows.delete(oldest)
    }
  }

  /** Newest first, at most `limit` rows; `total` is the unpaged live count. */
  list(limit: number = this.limit): { items: PendingChat[]; total: number } {
    this.expire(this.clock())
    const items = [...this.rows.values()].reverse().slice(0, Math.max(0, limit))
    return { items, total: this.rows.size }
  }

  /** Drop one entry (dismiss, or the chat just got bound). True when it existed. */
  remove(chatId: string): boolean {
    return this.rows.delete(chatId)
  }

  private expire(now: number): void {
    for (const [id, row] of this.rows) {
      if (now - row.lastSeen <= this.ttlMs) break // ordered by lastSeen: the rest are newer
      this.rows.delete(id)
    }
  }
}
