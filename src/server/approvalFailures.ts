// Error taxonomy + field validation for the human approval surface. Before this module every
// decision failure collapsed into `409 approval_decision_failed`, which made the client's typed
// messages (digest_mismatch, approval_expired, approval_not_pending) unreachable.
import { IllegalTransitionError, LedgerNotFoundError, StaleFenceError } from './ledger/ledgerModel'

export interface RouteFailure {
  status: number
  body: { error: string }
}

export const invalid = (field: string): RouteFailure => ({
  status: 400,
  body: { error: `invalid_${field}` },
})

export const failure = (status: number, error: string): RouteFailure => ({
  status,
  body: { error },
})

/** Non-empty trimmed string no longer than `max`; values are returned untrimmed. */
export function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value
    : undefined
}

/**
 * Maps a ledger rejection onto the HTTP contract the client branches on:
 * 403 for a changed action / stale nonce, 409 for state (expired, already decided, stale fence),
 * 404 for a missing row. Anything unrecognised is a 500 and never echoes the message back.
 */
export function classifyLedgerError(err: unknown): RouteFailure {
  if (err instanceof StaleFenceError) return failure(409, 'stale_fence')
  if (err instanceof LedgerNotFoundError) return failure(404, 'approval_not_found')
  if (err instanceof IllegalTransitionError) return failure(409, 'task_not_pending')
  const message = err instanceof Error ? err.message : ''
  if (/digest mismatch/i.test(message)) return failure(403, 'digest_mismatch')
  if (/nonce mismatch/i.test(message)) return failure(403, 'nonce_mismatch')
  if (/expired/i.test(message)) return failure(409, 'approval_expired')
  if (/already/i.test(message)) return failure(409, 'approval_not_pending')
  if (/must be a non-empty string/i.test(message)) return invalid('request')
  return failure(500, 'internal_error')
}
