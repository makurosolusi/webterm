// Field validation + failure taxonomy for the capability approval plane. Split out of
// `approvalApi.ts` so the router stays inside the 300-line budget while the taxonomy lives beside
// the constants it maps.
import { MAX_PROJECT_ID } from '../apiShared.types'

const MAX_SECRET_FIELD = 256

export const MAX_KIND = 128
export { MAX_PROJECT_ID }
export const MAX_ACTOR = 128
export const MAX_TASK_ID = 200

/** Non-empty string bounded by `max`; whitespace-only is rejected, values are not trimmed. */
export const textField = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined

/** Same as `textField` for digest/nonce: secrets are never trimmed or echoed. */
export const secretField = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_FIELD
    ? value
    : undefined

/** Ledger rejection -> HTTP contract. 403 = consent material changed, 409 = state. */
export function decisionFailure(err: unknown): { status: number; body: { error: string } } {
  const message = err instanceof Error ? err.message : ''
  if (/nonce mismatch/i.test(message)) return { status: 403, body: { error: 'nonce_mismatch' } }
  if (/digest mismatch/i.test(message)) return { status: 403, body: { error: 'digest_mismatch' } }
  if (/expired/i.test(message)) return { status: 409, body: { error: 'approval_expired' } }
  if (/already/i.test(message)) return { status: 409, body: { error: 'approval_not_pending' } }
  return { status: 400, body: { error: 'decision_failed' } }
}
