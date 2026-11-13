// The native app's update decisions, pure: when to check, what to do with a check's result, how long to back
// off after a failure, and when to tell the user. Electrobun's Updater is wired in by src/native/updater.ts
// through `UpdateDeps`, so the whole cycle runs headless in updatePolicy.bun.test.ts.

/** First check after launch: the window is up and the server answering before any network traffic. */
export const FIRST_CHECK_DELAY_MS = 30_000
/** Regular check interval while the app runs. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** First retry after a failed check or download; doubles per consecutive failure, capped at CHECK_INTERVAL_MS. */
export const FAILURE_BACKOFF_BASE_MS = 15 * 60 * 1000

/** What a check (or a download, read back from the updater's state) left behind. */
export type UpdateOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'none' }
  | { kind: 'available'; version: string; hash: string; ready: boolean }

export interface UpdateState {
  /** Consecutive failed cycles (check or download), reset by any success. */
  failures: number
  /** Hash of the downloaded update the user was already told about in this run (null: none yet). */
  notifiedHash: string | null
}

export const INITIAL_UPDATE_STATE: UpdateState = { failures: 0, notifiedHash: null }

/** Updates run only against a configured host (release.config.ts). */
export const updatesConfigured = (baseUrl: string): boolean => baseUrl.trim() !== ''

/** Wait before the next check: the regular interval, or the backoff after `failures` consecutive failures. */
export function nextCheckDelayMs(failures: number): number {
  if (failures <= 0) return CHECK_INTERVAL_MS
  return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1), CHECK_INTERVAL_MS)
}

export type UpdateAction =
  | { kind: 'warn'; message: string }
  | { kind: 'none' }
  | { kind: 'download'; version: string }
  | { kind: 'notify'; version: string; hash: string }
  | { kind: 'already-notified' }

/** The next step for an outcome, and the state after it. */
export function decide(state: UpdateState, outcome: UpdateOutcome): { action: UpdateAction; state: UpdateState } {
  if (outcome.kind === 'error') return { action: { kind: 'warn', message: outcome.message }, state: { ...state, failures: state.failures + 1 } }
  const ok = { ...state, failures: 0 }
  if (outcome.kind === 'none') return { action: { kind: 'none' }, state: ok }
  if (!outcome.ready) return { action: { kind: 'download', version: outcome.version }, state: ok }
  if (state.notifiedHash === outcome.hash) return { action: { kind: 'already-notified' }, state: ok }
  return { action: { kind: 'notify', version: outcome.version, hash: outcome.hash }, state: { ...ok, notifiedHash: outcome.hash } }
}

/** The Electrobun side of one cycle (src/native/updater.ts). Neither call throws: failures come back as an `error` outcome. */
export interface UpdateDeps {
  check(): Promise<UpdateOutcome>
  /** Download + verify + stage in the background, then the updater's state as an outcome. */
  download(): Promise<UpdateOutcome>
  /** Tell the user a downloaded update is ready to install. */
  notifyReady(version: string): void
  warn(message: string): void
  info(message: string): void
}

/** One check: download when available, tell the user once it is ready. Returns the state and the delay to the next check. */
export async function runUpdateCycle(state: UpdateState, deps: UpdateDeps): Promise<{ state: UpdateState; nextDelayMs: number }> {
  let step = decide(state, await deps.check())
  if (step.action.kind === 'download') {
    deps.info(`[webterm] update ${step.action.version} available: downloading in the background`)
    step = decide(step.state, await deps.download())
    // A finished download that is still not staged is a failure, not a reason to download again in this cycle.
    if (step.action.kind === 'download') step = decide(state, { kind: 'error', message: 'the download finished but the update is not staged' })
  }
  const { action } = step
  if (action.kind === 'warn') deps.warn(`[webterm] update check failed (attempt ${step.state.failures}): ${action.message}`)
  if (action.kind === 'notify') deps.notifyReady(action.version)
  return { state: step.state, nextDelayMs: nextCheckDelayMs(step.state.failures) }
}
