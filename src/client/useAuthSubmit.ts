// Submit state shared by the sign-in, setup and Account forms: pending flag, the last failure and its
// sentence, with a 429 failure counting down from Retry-After (the sentence goes once it is over).
import { useCallback, useState } from 'react'
import { useCountdown } from './useCountdown'

const HTTP_TOO_MANY = 429

/** A refused answer (status + server code + Retry-After seconds) or a ready sentence (network, client check). */
export type AuthFailure = { status: number; error: string | null; retryAfterS: number } | { message: string }
type Held = { status: number; error: string | null; until: number } | { message: string }

/** Pending + failure state; `toText` turns a refused answer (and seconds left) into a sentence. */
export function useAuthSubmit(now: () => number, toText: (status: number, error: string | null, retryS: number) => string) {
  const [pending, setPending] = useState(false)
  const [failure, setHeld] = useState<Held | null>(null)
  // A 429 without Retry-After still waits a second, so the user sees why the button did nothing.
  const setFailure = useCallback((f: AuthFailure | null): void => {
    setHeld(f === null || 'message' in f ? f : { status: f.status, error: f.error, until: now() + Math.max(1, f.retryAfterS) * 1000 })
  }, [now])
  const until = failure && 'until' in failure && failure.status === HTTP_TOO_MANY ? failure.until : 0
  const left = useCountdown(until, now)
  const text = failure === null ? null
    : 'message' in failure ? failure.message
      : failure.status === HTTP_TOO_MANY && left === 0 ? null
        : toText(failure.status, failure.error, left)
  return { pending, setPending, setFailure, text, blocked: left > 0 }
}
