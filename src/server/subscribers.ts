// Broadcast fan-out primitive shared by the WebSocket hub. Deliberately dependency-free so it can
// be unit-tested in node-env without pulling in sessions (which imports bun modules at load).

import { createLogger } from './logs'

const log = createLogger('ws')

export type Subscriber<T> = (msg: T) => void

/**
 * Ordered set of `(msg: T) => void` callbacks with mutation-safe broadcast.
 *
 * Insertion order is the delivery order. `send` iterates an `Array.from` snapshot, so a subscriber
 * that adds or removes subscribers during delivery never changes who receives the current message.
 */
export class SubscriberSet<T> {
  private readonly subscribers = new Set<Subscriber<T>>()

  /** Registers `fn`. Returns false when it was already registered. */
  add(fn: Subscriber<T>): boolean {
    if (this.subscribers.has(fn)) return false
    this.subscribers.add(fn)
    return true
  }

  /** Unregisters `fn`. Returns false when it was not registered. */
  remove(fn: Subscriber<T>): boolean {
    return this.subscribers.delete(fn)
  }

  has(fn: Subscriber<T>): boolean {
    return this.subscribers.has(fn)
  }

  size(): number {
    return this.subscribers.size
  }

  clear(): void {
    this.subscribers.clear()
  }

  /**
   * Delivers `msg` to every subscriber present when the call started.
   *
   * A throwing subscriber never starves its peers: the error is passed to `onError` and delivery
   * continues. `onError` receives only the error, never subscriber identity. Without `onError` the
   * failure is reported on the system log rather than silently swallowed or rethrown into the
   * broadcast loop.
   */
  send(msg: T, onError?: (err: unknown) => void): void {
    for (const fn of Array.from(this.subscribers)) {
      try {
        fn(msg)
      } catch (err) {
        if (onError) onError(err)
        else log.error('subscribers.error', '[subscribers] subscriber threw', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      }
    }
  }
}
