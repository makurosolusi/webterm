// Peer-scoped throttle for failed webhook authentication. A wrong `secret_token` costs an attacker
// one request and costs us nothing, so without a counter a short secret is guessable in minutes
// (QC M3). Only failures are counted, so a busy real chat is never throttled.
export const WEBHOOK_FAILURE_LIMIT = 30
export const WEBHOOK_FAILURE_WINDOW_MS = 60_000

/** Bound on tracked peers; clearing is safe because every blocked peer stays blocked until retry. */
const MAX_TRACKED_PEERS = 1024

export class FailureThrottle {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number = WEBHOOK_FAILURE_LIMIT,
    private readonly windowMs: number = WEBHOOK_FAILURE_WINDOW_MS,
    private readonly clock: () => number = Date.now
  ) {}

  /** Seconds until the peer may retry, or null when it is not blocked. */
  retryAfterSeconds(key: string): number | null {
    const entry = this.hits.get(key)
    if (!entry) return null
    const now = this.clock()
    if (now >= entry.resetAt) {
      this.hits.delete(key)
      return null
    }
    if (entry.count < this.limit) return null
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  }

  recordFailure(key: string): void {
    const now = this.clock()
    const entry = this.hits.get(key)
    if (!entry || now >= entry.resetAt) {
      if (this.hits.size >= MAX_TRACKED_PEERS) this.hits.clear()
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    entry.count += 1
  }
}
