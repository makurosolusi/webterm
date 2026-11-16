// The API's "limit resets at" instant, remembered so nobody is punished for waiting it out. Memory only: a restart
// forgets it and the first rejected turn after it records it again.

/** `resetsAt` below this is epoch seconds (the CLI passes the API's header through; sdk.d.ts types it only as `number`, the chat mapper and its tests use seconds). */
const EPOCH_MS_MIN = 1e12
const MS_PER_S = 1_000

/** Epoch ms of a `resetsAt` given in either unit: seconds are ~1.7e9 and ms ~1.7e12, so the 1e12 cut cannot confuse them for millennia. */
export function normalizeResetsAt(raw: number): number {
  return raw < EPOCH_MS_MIN ? raw * MS_PER_S : raw
}

export interface RateLimitHold {
  /** Records a `rate_limit_event`; only `rejected` with a reset instant holds anything (a warning is not a block). */
  note(info: { status: string; resetsAt?: number }): void
  /** The reset instant while it is still ahead of `now`, else null. */
  resetAt(now: number): number | null
}

/** One hold per process; tests build their own. */
export function createRateLimitHold(): RateLimitHold {
  let until: number | null = null
  return {
    note({ status, resetsAt }) {
      if (status === 'rejected' && typeof resetsAt === 'number' && Number.isFinite(resetsAt)) until = normalizeResetsAt(resetsAt)
    },
    resetAt: (now) => (until !== null && until > now ? until : null),
  }
}

export const processRateLimit: RateLimitHold = createRateLimitHold()

/** The instant the current rate limit resets, or null when none is pending. */
export const rateLimitResetAt = (now: number): number | null => processRateLimit.resetAt(now)
