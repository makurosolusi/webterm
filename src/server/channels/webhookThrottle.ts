// Sliding-window auth-failure counter shared by every channel webhook verifier.

/** Default auth-failure budget per key inside the window. */
export const DEFAULT_AUTH_FAILURE_LIMIT = 30
export const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000
/** Bound on tracked keys so a distributed attacker cannot grow the map without limit. */
const MAX_THROTTLE_KEYS = 4096

/** Sliding-window failure counter: N failures per key in the window, then the key is blocked. */
export class AttemptThrottle {
  private readonly limit: number
  private readonly windowMs: number
  private readonly clock: () => number
  private readonly buckets = new Map<string, { failures: number; resetAt: number }>()

  constructor(
    options: { limit?: number; windowMs?: number; now?: () => number } = {}
  ) {
    const limit = options.limit ?? DEFAULT_AUTH_FAILURE_LIMIT
    const windowMs = options.windowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('throttle limit must be positive')
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('throttle window must be positive')
    this.limit = limit
    this.windowMs = windowMs
    this.clock = options.now ?? Date.now
  }

  /** True when `key` may still attempt. Does not consume budget. */
  allow(key: string): boolean {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return true
    if (this.clock() >= bucket.resetAt) {
      this.buckets.delete(key)
      return true
    }
    return bucket.failures < this.limit
  }

  /** Records one failed attempt; returns the remaining budget (0 means now blocked). */
  fail(key: string): number {
    const now = this.clock()
    const bucket = this.buckets.get(key)
    if (bucket === undefined || now >= bucket.resetAt) {
      this.evict(now)
      this.buckets.set(key, { failures: 1, resetAt: now + this.windowMs })
      return Math.max(0, this.limit - 1)
    }
    bucket.failures += 1
    return Math.max(0, this.limit - bucket.failures)
  }

  /** Clears the budget after a proven-good credential. */
  succeed(key: string): void {
    this.buckets.delete(key)
  }

  size(): number {
    return this.buckets.size
  }

  private evict(now: number): void {
    if (this.buckets.size < MAX_THROTTLE_KEYS) return
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
    // Still full: drop the oldest insertion (a guess flood cannot pin memory forever).
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_THROTTLE_KEYS) break
      this.buckets.delete(key)
    }
  }
}
