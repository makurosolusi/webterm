// In-memory login throttle, keyed by account (`user:<lowercased username>`) and by peer
// (`ip:<socket remoteAddress>`): from the BACKOFF_AFTER-th failure on, each failure sets a wait that doubles,
// capped at MAX_BACKOFF_MS. Never a permanent lockout (an attacker must not be able to lock the owner
// out for good), and the map is bounded so a spray of usernames cannot grow memory. State resets on
// restart, which is fine for a single-user loopback server.

/** The failure that starts the backoff (OWASP: a small number of free tries, then wait). */
export const BACKOFF_AFTER = 5
export const BASE_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 15 * 60 * 1000
/** A key with no failure for this long is forgotten (its counter starts over). */
export const FORGET_MS = 24 * 60 * 60 * 1000
/** Map bound; the least recently failed key is evicted first. */
export const MAX_KEYS = 5000

export type ThrottleVerdict = { ok: true } | { ok: false; retryAfterMs: number }

export interface LoginThrottle {
  /** Refused while any key is waiting; `retryAfterMs` is the longest wait. */
  check(keys: readonly string[]): ThrottleVerdict
  fail(keys: readonly string[]): void
  succeed(keys: readonly string[]): void
}

interface Entry { fails: number; lastFail: number; until: number }

/** Keys for one attempt: the account (case-insensitive, as ui_user) and the peer address. */
export function throttleKeys(username: string, remoteAddress: string | undefined): string[] {
  return [`user:${username.toLowerCase()}`, `ip:${remoteAddress ?? 'unknown'}`]
}

export function createLoginThrottle(now: () => number = Date.now, maxKeys: number = MAX_KEYS): LoginThrottle {
  const map = new Map<string, Entry>()
  const entry = (key: string): Entry | undefined => {
    const e = map.get(key)
    if (e && now() - e.lastFail > FORGET_MS) {
      map.delete(key)
      return undefined
    }
    return e
  }
  return {
    check(keys) {
      const t = now()
      const wait = Math.max(0, ...keys.map((k) => (entry(k)?.until ?? 0) - t))
      return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true }
    },
    fail(keys) {
      const t = now()
      for (const k of keys) {
        const fails = (entry(k)?.fails ?? 0) + 1
        const over = fails - BACKOFF_AFTER
        const until = over >= 0 ? t + Math.min(BASE_BACKOFF_MS * 2 ** Math.min(over, 30), MAX_BACKOFF_MS) : 0
        map.delete(k) // re-insert so Map order = least recently failed first
        map.set(k, { fails, lastFail: t, until })
        while (map.size > maxKeys) map.delete(map.keys().next().value as string)
      }
    },
    succeed(keys) {
      for (const k of keys) map.delete(k)
    },
  }
}

/** Process-wide throttle used by the login route. */
export const loginThrottle: LoginThrottle = createLoginThrottle()
