// Inbound dedupe (O10): providers deliver at-least-once, so every provider event id is claimed
// before it can have an effect. A duplicate claim returns the stored outcome without running the
// effect again. The store is bounded in memory, which is enough for one durable-insert process;
// the SQLite `UNIQUE(account_id, external_event_id)` row remains the cross-restart truth.
export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
export const DEDUPE_LIMIT = 4096

export interface DedupeOptions {
  ttlMs?: number
  limit?: number
  now?: () => number
}

export interface OnceResult<T> {
  /** True when this call replayed an earlier claim; `true` means no second effect ran. */
  duplicate: boolean
  value: T | undefined
}

interface Entry {
  at: number
  settled: boolean
  value?: unknown
  promise?: Promise<unknown>
}

/** Canonical key: channel scoping prevents two providers reusing the same update id. */
export function dedupeKey(channel: string, externalEventId: string | number): string {
  return `${channel}:${String(externalEventId)}`
}

export class DedupeStore {
  private readonly ttlMs: number
  private readonly limit: number
  private readonly clock: () => number
  private readonly entries = new Map<string, Entry>()

  constructor(options: DedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEDUPE_TTL_MS
    this.limit = Math.max(1, options.limit ?? DEDUPE_LIMIT)
    this.clock = options.now ?? Date.now
  }

  /** True when the key is claimed and still inside its TTL. Does not claim. */
  has(key: string): boolean {
    this.prune()
    return this.entries.has(key)
  }

  /**
   * Reserve a key before side effects. `false` means "already claimed" (in flight or settled):
   * the caller must treat this delivery as a replay and skip the effect entirely.
   */
  claim(key: string): boolean {
    this.prune()
    if (this.entries.has(key)) return false
    this.entries.set(key, { at: this.clock(), settled: false })
    this.evict()
    return true
  }

  /**
   * Run `effect` exactly once per key inside the TTL. Concurrent replays await the same promise,
   * so they observe the first outcome instead of racing a second effect. A failed effect removes
   * the claim so a provider retry can succeed; a successful one is remembered.
   */
  once<T>(key: string, effect: () => Promise<T> | T): Promise<OnceResult<T>> {
    this.prune()
    const existing = this.entries.get(key)
    if (existing) return this.replay<T>(existing)

    const entry: Entry = { at: this.clock(), settled: false }
    // Insert before running the effect: a synchronous throw inside `effect` must delete the claim,
    // not have the claim re-added afterwards by a late `set`.
    this.entries.set(key, entry)
    const run = (async () => {
      try {
        const value = await effect()
        entry.value = value
        entry.settled = true
        return value
      } catch (err) {
        // Failure is not a durable outcome: drop the claim so the next delivery may retry.
        this.entries.delete(key)
        throw err
      }
    })()
    entry.promise = run
    this.evict()
    return run.then((value) => ({ duplicate: false, value }))
  }

  size(): number {
    this.prune()
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  /** Drop entries past TTL. Effects are short-lived; 24h is far beyond any in-flight handler. */
  prune(): void {
    const cutoff = this.clock() - this.ttlMs
    for (const [key, entry] of this.entries) {
      if (entry.at <= cutoff) this.entries.delete(key)
    }
  }

  private async replay<T>(existing: Entry): Promise<OnceResult<T>> {
    if (!existing.settled) {
      const value = (await existing.promise) as T
      return { duplicate: true, value }
    }
    return { duplicate: true, value: existing.value as T }
  }

  /** Bounded store: oldest settled keys go first; an unsettled key is never evicted. */
  private evict(): void {
    if (this.entries.size <= this.limit) return
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limit) return
      if (entry.settled) this.entries.delete(key)
    }
  }
}
