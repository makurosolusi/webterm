// Lets a producer outside the work engine (a held permission prompt) ask for the check-in pass to run now instead of
// on the next 30 s tick. workTracking registers the pass; with no engine running, `kickCheckin` says so.
let kick: (() => void) | null = null

/** Registered by workTracking; `null` on stop. */
export function setCheckinKick(fn: (() => void) | null): void { kick = fn }

/** Runs the pass soon; false when no engine is running (the caller must not count on a wake). */
export function kickCheckin(): boolean {
  if (!kick) return false
  kick()
  return true
}
