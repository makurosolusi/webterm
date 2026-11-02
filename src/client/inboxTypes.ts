// Tipe publik inbox/approval. Dipisah dari client fetch agar file API tetap di bawah batas.

export type InboxState = 'needs_you' | 'review' | 'broken'

export interface InboxItem {
  id: string
  kind: string
  state: InboxState
  projectId: string
  title: string
  ageMs: number
  detail?: string
  /** Task fence for review; absent on approval items. */
  fence?: number
}

export interface ApprovalChallenge {
  id: string
  digest: string
  nonce: string
  expiresAt: number
  kind: string
  projectId: string
}

export interface ApprovalRequestInput {
  kind: string
  projectId: string
  /** The exact action being approved. The server digests this value; the client never decides
   *  what the digest is, it only echoes back what the server returned. */
  request: unknown
  /** Idempotency key for the control plane. Generated when omitted. */
  requestId?: string
}

export interface ApprovalDecideInput {
  id: string
  digest: string
  nonce: string
  approve: boolean
  actor?: string
  /** Idempotency key for the control plane. Generated when omitted. */
  requestId?: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalDecision {
  id: string
  status: ApprovalStatus
  digest?: string
  expiresAt?: number
}

export interface ApprovalConsumeInput {
  id: string
  digest: string
  /** Idempotency key for the control plane. Generated when omitted. */
  requestId?: string
}

export interface ApprovalConsumeResult {
  ok: boolean
  id?: string
}

/**
 * Approved-but-unconsumed consent (QC B4). When a decide response is lost the row leaves the
 * inbox (pending-only) but the approval still exists: this is the only read path that can resume
 * it. `taskId`/`fence` are the server-derived task link, absent for non-task approvals.
 */
export interface ApprovedApproval {
  id: string
  projectId: string
  kind: string
  taskId?: string
  fence?: number
  digest: string
  expiresAt: number
}

export interface RequestOptions {
  signal?: AbortSignal
}

/** The four calls the panel needs. Pass a fake in tests; the default is `inboxApi` below. */
export interface InboxClient {
  listInbox(opts?: RequestOptions): Promise<InboxItem[]>
  /** Optional so existing fakes keep compiling: without it the panel simply cannot resume. */
  listApproved?(opts?: RequestOptions): Promise<ApprovedApproval[]>
  getApprovalChallenge(id: string, opts?: RequestOptions): Promise<ApprovalChallenge>
  requestApproval(input: ApprovalRequestInput, opts?: RequestOptions): Promise<ApprovalChallenge>
  decideApproval(input: ApprovalDecideInput, opts?: RequestOptions): Promise<ApprovalDecision>
  consumeApproval(input: ApprovalConsumeInput, opts?: RequestOptions): Promise<ApprovalConsumeResult>
}

/**
 * Typed failure from the inbox API. `code` is the server's machine-readable error (e.g.
 * `digest_mismatch`, `nonce_reused`, `forbidden`) when the body provided one, otherwise
 * `http_<status>` or `bad_response`. No request data or token is embedded in the message.
 */
export class InboxApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'InboxApiError'
    this.status = status
    this.code = code
  }
}
