// Transactional outbox (O11/O14). The ledger enqueues a notification row in the same transaction
// that writes the state change, then a dispatcher sends it later. Sending NEVER throws into the
// ledger: a provider outage becomes `retry` (with backoff) or `dead` (dead-letter), never an
// exception. Keys are idempotency keys, so a replayed enqueue cannot produce a second effect.
import { redactSecrets } from './webhook'

export const OUTBOX_MAX_ATTEMPTS = 5
export const OUTBOX_BASE_DELAY_MS = 1000
export const OUTBOX_MAX_DELAY_MS = 60_000
export const OUTBOX_LIMIT = 1000

export type OutboxState = 'pending' | 'sent' | 'dead'
export type EnqueueOutcome = 'queued' | 'duplicate' | 'full'
export type DispatchOutcome = 'sent' | 'retry' | 'dead' | 'missing'

export interface OutboxEntry<P = unknown> {
  key: string
  channel: string
  payload: P
  attempts: number
  nextAt: number
  state: OutboxState
  createdAt: number
  sentAt?: number
  lastError?: string
}

export interface OutboxOptions {
  /** Injected clock (ms). Tests advance a mutable value instead of sleeping. */
  now?: () => number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Jitter hook applied to each computed delay; default is identity (deterministic tests). */
  jitter?: (delayMs: number) => number
  limit?: number
  /** Egress scrubber for error strings; defaults to `redactSecrets`. */
  sanitize?: (text: string) => string
}

/** Exponential backoff with a hard ceiling: attempt 1 = base, 2 = 2x, 3 = 4x, ... */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempt - 1)
  return Math.min(maxMs, baseMs * 2 ** exponent)
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : 'unknown_outbox_error'
}

export class Outbox<P = unknown> {
  private readonly clock: () => number
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitter: (delayMs: number) => number
  private readonly limit: number
  private readonly sanitize: (text: string) => string
  private readonly entries = new Map<string, OutboxEntry<P>>()

  constructor(options: OutboxOptions = {}) {
    this.clock = options.now ?? Date.now
    this.maxAttempts = Math.max(1, options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS)
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? OUTBOX_BASE_DELAY_MS)
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? OUTBOX_MAX_DELAY_MS)
    this.jitter = options.jitter ?? ((delayMs) => delayMs)
    this.limit = Math.max(1, options.limit ?? OUTBOX_LIMIT)
    this.sanitize = options.sanitize ?? ((text) => redactSecrets(text))
  }

  /** Insert once per idempotency key. Existing rows (any state) are never overwritten. */
  enqueue(key: string, channel: string, payload: P): EnqueueOutcome {
    if (!key.trim() || !channel.trim()) throw new Error('outbox: key and channel are required')
    if (this.entries.has(key)) return 'duplicate'
    this.makeRoom()
    if (this.entries.size >= this.limit) return 'full'
    const now = this.clock()
    this.entries.set(key, {
      key,
      channel,
      payload,
      attempts: 0,
      nextAt: now,
      state: 'pending',
      createdAt: now,
    })
    return 'queued'
  }

  get(key: string): OutboxEntry<P> | undefined {
    const entry = this.entries.get(key)
    return entry ? this.copy(entry) : undefined
  }

  /** Pending entries whose backoff has elapsed, oldest first. The scheduler sends only these. */
  due(now = this.clock()): OutboxEntry<P>[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'pending' && entry.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt)
      .map((entry) => this.copy(entry))
  }

  pending(): OutboxEntry<P>[] {
    return this.byState('pending')
  }

  deadLetters(): OutboxEntry<P>[] {
    return this.byState('dead')
  }

  /** Queue state for health/status surfaces; contains no secret because payloads are caller data. */
  stats(): { pending: number; sent: number; dead: number; attempts: number } {
    let pending = 0
    let sent = 0
    let dead = 0
    let attempts = 0
    for (const entry of this.entries.values()) {
      attempts += entry.attempts
      if (entry.state === 'pending') pending += 1
      else if (entry.state === 'sent') sent += 1
      else dead += 1
    }
    return { pending, sent, dead, attempts }
  }

  /** Serializable queue snapshot for tests/logs; error text is already scrubbed. */
  snapshot(): OutboxEntry<P>[] {
    return [...this.entries.values()].map((entry) => this.copy(entry))
  }

  /**
   * Attempt one send. Never throws: any provider error is recorded and mapped to `retry`/`dead`.
   * A not-yet-due entry returns `retry` without calling the sender, so backoff is enforced here.
   */
  async dispatch(key: string, send: (entry: OutboxEntry<P>) => Promise<void>): Promise<DispatchOutcome> {
    const entry = this.entries.get(key)
    if (!entry) return 'missing'
    if (entry.state === 'sent') return 'sent'
    if (entry.state === 'dead') return 'dead'
    if (entry.nextAt > this.clock()) return 'retry'

    try {
      await send(this.copy(entry))
      entry.state = 'sent'
      entry.sentAt = this.clock()
      entry.lastError = undefined
      return 'sent'
    } catch (err) {
      entry.attempts += 1
      entry.lastError = this.sanitize(errorText(err)).slice(0, 300)
      if (entry.attempts >= this.maxAttempts) {
        entry.state = 'dead'
        entry.nextAt = this.clock()
        return 'dead'
      }
      entry.nextAt = this.clock() + this.jitter(backoffDelayMs(entry.attempts, this.baseDelayMs, this.maxDelayMs))
      return 'retry'
    }
  }

  /** Move a dead letter back to pending with a fresh attempt budget. */
  retryDead(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry || entry.state !== 'dead') return false
    entry.state = 'pending'
    entry.attempts = 0
    entry.nextAt = this.clock()
    entry.lastError = undefined
    return true
  }

  private byState(state: OutboxState): OutboxEntry<P>[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === state)
      .map((entry) => this.copy(entry))
  }

  private copy(entry: OutboxEntry<P>): OutboxEntry<P> {
    return { ...entry }
  }

  /** Reclaim sent rows before reporting `full`; queued work is never silently dropped. */
  private makeRoom(): void {
    if (this.entries.size < this.limit) return
    for (const [key, entry] of this.entries) {
      if (entry.state === 'sent') this.entries.delete(key)
    }
  }
}
