// Approval gate P3 (RND/03 §8, 07-IMPLEMENTASI-P3-P5.md P3-7): aksi ireversibel hanya jalan
// setelah consent `approved` di-consume TEPAT sekali. Chat bukan consent; digest mengikat aksi
// yang disetujui, dan kegagalan aksi tidak pernah menghidupkan kembali approval yang sama.
import { type Approval, approvalDigest } from '../ledger/ledgerApproval'

export type ApprovalRejectionCode =
  | 'approval_not_found'
  | 'approval_pending'
  | 'approval_rejected'
  | 'approval_expired'
  | 'approval_not_approved'
  | 'approval_digest_mismatch'
  | 'approval_already_consumed'

export class ApprovalRequiredError extends Error {
  constructor(
    readonly code: ApprovalRejectionCode,
    message: string,
    readonly approvalId: string
  ) {
    super(message)
    this.name = 'ApprovalRequiredError'
  }
}

/** Potongan `ledger.approval`; facade asli memenuhi bentuk ini. */
export interface ApprovalPort {
  getApproval(id: string): Approval | null
  consumeApproval(id: string, input: { digest: string; now?: number }): boolean
}

export interface ApprovalGateDeps {
  approval: ApprovalPort
}

export interface ApprovalRequest {
  approvalId: string
  /** Digest `ledger.approval.digest(action)` yang disetujui manusia. */
  digest: string
  /** Jam injeksi; default `Date.now()` dan diteruskan ke `consumeApproval`. */
  now?: number
}

function reject(code: ApprovalRejectionCode, approvalId: string, detail: string): ApprovalRequiredError {
  return new ApprovalRequiredError(code, `approval ${approvalId} rejected: ${detail}`, approvalId)
}

/**
 * Precheck memberi alasan presisi sebelum consume; `consumeApproval` tetap penentu akhir karena
 * hanya ledger yang atomik. Status `false` di sini berarti approval sudah dipakai consumer lain.
 */
export async function runApproved<T>(
  deps: ApprovalGateDeps,
  request: ApprovalRequest,
  action: () => T | Promise<T>
): Promise<T> {
  const approvalId = typeof request?.approvalId === 'string' ? request.approvalId.trim() : ''
  if (approvalId === '') throw reject('approval_not_found', '', 'approvalId is required')
  const digest = typeof request.digest === 'string' ? request.digest : ''
  if (digest === '') throw reject('approval_digest_mismatch', approvalId, 'digest is required')

  const now = request.now ?? Date.now()
  const approval = deps.approval.getApproval(approvalId)
  if (!approval) throw reject('approval_not_found', approvalId, 'no such approval')
  if (approval.expiresAt !== null && approval.expiresAt <= now) {
    throw reject('approval_expired', approvalId, `expired at ${approval.expiresAt}`)
  }
  if (approval.status === 'pending') throw reject('approval_pending', approvalId, 'decision is pending')
  if (approval.status === 'rejected') throw reject('approval_rejected', approvalId, 'decision was rejected')
  if (approval.status === 'expired') throw reject('approval_expired', approvalId, 'decision expired')
  if (approval.status !== 'approved') {
    throw reject('approval_not_approved', approvalId, `status is ${approval.status}`)
  }
  if (approvalDigest(approval.request) !== digest) {
    throw reject('approval_digest_mismatch', approvalId, 'action changed since approval')
  }

  const consumed = deps.approval.consumeApproval(
    approval.id,
    request.now === undefined ? { digest } : { digest, now: request.now }
  )
  if (!consumed) throw reject('approval_already_consumed', approvalId, 'already consumed or expired')

  // Tidak ada catch: kegagalan action diteruskan apa adanya dan approval tetap hangus.
  return await action()
}
