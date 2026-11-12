// A settings save that never ends leaves "Saving…" on screen forever (e.g. the browser queues the request
// behind its per-host connection limit). Every settings PUT carries this timeout so the save settles as an
// error with Retry instead.

/** How long a settings PUT may wait for the server before it fails. */
export const SAVE_TIMEOUT_MS = 15_000

/** The signal for one settings PUT: aborts with a `TimeoutError` after SAVE_TIMEOUT_MS. Built on `setTimeout`, not
 *  `AbortSignal.timeout`, whose internal timer fake timers cannot drive, so the timeout path stays testable. */
export function saveTimeoutSignal(): AbortSignal {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(new DOMException('signal timed out', 'TimeoutError')), SAVE_TIMEOUT_MS)
  return ctrl.signal
}

/** `err` from a settings PUT as the error to show: a timeout says so in plain words, anything else is kept. */
export function saveFetchError(err: unknown): unknown {
  // By name: a DOMException is not `instanceof Error` in every environment (jsdom).
  if ((err as { name?: unknown } | null)?.name === 'TimeoutError') {
    return new Error(`The server did not answer in ${SAVE_TIMEOUT_MS / 1000} s`, { cause: err })
  }
  return err
}
