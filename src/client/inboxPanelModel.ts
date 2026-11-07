// Consent helpers for the Needs-you task review (`chat/needsYouReview`), kept from the old Inbox panel.
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ApprovalChallenge, ApprovalRequestInput, ApprovedApproval, InboxClient, InboxItem } from './inboxApi'
import type { ReviewState } from './inboxApprovalDialog'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The exact action the server digests for a review item. Shared by the deferred flow (a task
 * review mints its challenge only when the operator presses Approve/Reject) and by the immediate
 * approval flow, so both always describe the same action.
 */
export function approvalRequest(item: InboxItem): ApprovalRequestInput {
  return {
    kind: item.kind,
    projectId: item.projectId,
    request: {
      itemId: item.id,
      taskId: item.kind === 'task' ? item.id : undefined,
      fence: item.fence,
      title: item.title,
      detail: item.detail ?? null,
    },
  }
}

/**
 * Why a task row cannot be reviewed yet, or null when it can. A task approval whose request has
 * no `fence` can be recorded but never consumed (the server cannot transition the task), so the
 * panel must not mint one. Non-task items are never blocked.
 */
export function reviewBlockedReason(item: InboxItem): string | null {
  if (item.kind !== 'task') return null
  return item.fence === undefined
    ? 'This task has no fence yet, so it cannot be reviewed. Try again in a moment.'
    : null
}

/** Approved-unconsumed consent for this review row (QC B4); needs the same task and fence. */
export function resumeApprovalFor(
  item: InboxItem,
  approved: readonly ApprovedApproval[]
): ApprovedApproval | null {
  if (item.kind !== 'task') return null
  for (const cand of approved) {
    if (cand.projectId !== item.projectId || cand.taskId !== item.id) continue
    if (cand.fence !== undefined && item.fence !== undefined && cand.fence !== item.fence) continue
    return cand
  }
  return null
}
/** Dialog state that resumes existing consent at the explicit Consume step (never auto-consumes). */
export function resumeReviewState(resume: ApprovedApproval, queue: InboxItem[], index = 0): ReviewState {
  const challenge: ApprovalChallenge = {
    id: resume.id,
    digest: resume.digest,
    expiresAt: resume.expiresAt,
    kind: 'approval',
    projectId: resume.projectId,
    nonce: '',
  }
  return { queue, index, challenge, deferred: false, phase: 'approved', error: null, checked: false, text: '', approvedDigest: resume.digest }
}
/** Approved list for the resume path; `ready` is false until the current open's read settles. */
export function useApprovedApprovals(
  opts: { enabled: boolean; client: RefObject<InboxClient>; refreshKey: number }
): { approved: readonly ApprovedApproval[]; ready: boolean } {
  const [list, setList] = useState({ approved: [] as readonly ApprovedApproval[], ready: !opts.enabled })
  // Reopening starts an unanswered read, so re-gate; adjusting state during render (React's
  // prop-change pattern) leaves no stale frame, and `refreshKey` changes keep readiness.
  const wasEnabled = useRef(opts.enabled)
  const reopened = wasEnabled.current !== opts.enabled && opts.enabled
  wasEnabled.current = opts.enabled
  if (reopened) setList({ approved: list.approved, ready: false })
  useEffect(() => {
    const lister = opts.enabled ? opts.client.current.listApproved : undefined
    const controller = new AbortController()
    const settle = (next: readonly ApprovedApproval[]): unknown =>
      !controller.signal.aborted && setList({ approved: next, ready: true })
    if (!lister) return void settle([])
    lister({ signal: controller.signal }).then(settle, () => settle([]))
    return () => controller.abort()
  }, [opts.enabled, opts.client, opts.refreshKey])
  return list
}
/**
 * Focus trap + Escape for the approval dialog. `pending` mirrors the phase: while a request is in
 * flight Escape must not abandon it. Split out of the review hook so it stays inside the
 * repo's file-size budget.
 */
export function useInboxDialogKeys(options: {
  open: boolean
  dialogRef: RefObject<HTMLDivElement | null>
  pending: boolean
  onClose: () => void
}): void {
  const { open, dialogRef, pending, onClose } = options
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = dialogRef.current
    const focusables = (): HTMLElement[] =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
    focusables()[0]?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!pendingRef.current) closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !node) return
      const list = focusables()
      if (list.length === 0) {
        event.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      const outside = !node.contains(active)
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, dialogRef])
}
