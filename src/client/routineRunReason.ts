// Turns the server's routine-run reason (`retryable[network]: <detail>`, `retried[network]: <detail>`,
// or free text) into words for the UI. The prefixes are a server protocol (routineModel.ts) and must
// never reach the screen. Pure, so the mapping is testable without rendering.

export type RunStatusValue = 'running' | 'ran' | 'skipped' | 'failed'
/** What the row shows: the server status, or one of the two derived states of a transient failure. */
export type DisplayRunStatus = RunStatusValue | 'retrying' | 'retried'

export interface RunReasonView {
  status: DisplayRunStatus
  /** Status in words, e.g. "Retrying after a connection problem". */
  label: string
  /** Reason text for the user, with no protocol prefix; null when there is none. */
  reason: string | null
}

const BASE_LABEL: Record<RunStatusValue, string> = { running: 'Running', ran: 'Ran', skipped: 'Skipped', failed: 'Failed' }
const RETRYING_LABEL = 'Retrying after a connection problem'
const RETRIED_LABEL = 'Retried'

/** Friendly cause per failure class (`FailureKind` in server/central/work/workFailureKind.ts). */
const CAUSE_TEXT: Record<string, string> = {
  network: 'the connection to Claude dropped',
  rate_limited: 'Claude is limiting requests for now',
  overloaded: 'Claude is overloaded right now',
  server: 'Claude had a temporary server problem',
}
const UNKNOWN_CAUSE = 'a temporary problem'

const PREFIXED = /^(retryable|retried)\[([^\]]*)\](?::\s*([\s\S]*))?$/

/** Describe a run's status and reason for display. A `failed` run with a `retryable[…]` reason is "retrying", not failed. */
export function describeRunReason(status: RunStatusValue, rawReason: string | null): RunReasonView {
  const base = BASE_LABEL[status] ?? status
  if (!rawReason) return { status, label: base, reason: null }
  const match = status === 'failed' ? PREFIXED.exec(rawReason) : null
  if (!match) return { status, label: base, reason: rawReason }
  const [, prefix, kind, detail] = match
  if (prefix === 'retryable') {
    return { status: 'retrying', label: RETRYING_LABEL, reason: `${CAUSE_TEXT[kind] ?? UNKNOWN_CAUSE}; it will run again shortly` }
  }
  return { status: 'retried', label: RETRIED_LABEL, reason: detail?.trim() || `${CAUSE_TEXT[kind] ?? UNKNOWN_CAUSE}; it was run again` }
}
