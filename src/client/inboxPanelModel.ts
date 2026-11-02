// Small helpers/state for InboxPanel. Dipisah supaya komponen utama tetap di bawah batas file.
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ApprovalChallenge, ApprovalRequestInput, ApprovedApproval, InboxClient, InboxItem, InboxState } from './inboxApi'
import type { ReviewState } from './inboxApprovalDialog'
import { publishInboxCount } from './inboxDockState'

export const SECTION_ORDER: readonly InboxState[] = ['needs_you', 'review', 'broken']

export const SECTION_LABEL: Record<InboxState, string> = {
  needs_you: 'Needs you',
  review: 'Review',
  broken: 'Broken',
}

export const OPEN_KEY = 'webterm.inboxOpen'

export const FOCUSABLE =
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
    ? 'This task has no fence yet, so it cannot be reviewed. Refresh the inbox.'
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
 * Mirror the open panel's count into the Dock badge. While the panel owns `/api/inbox` it is the
 * only poller; publishing here (instead of a second `fetch` loop) is what keeps the badge correct
 * on boot and immediately after a consume/reject. `null` clears the value on close so a reopened
 * panel never inherits a stale number.
 */
export function useInboxCountPublisher(open: boolean, items: readonly InboxItem[] | null): void {
  useEffect(() => {
    if (!open) {
      publishInboxCount(null)
      return
    }
    if (items === null) return
    publishInboxCount(items.length)
  }, [open, items])
}

/**
 * Focus trap + Escape for the approval dialog. `pending` mirrors the phase: while a request is in
 * flight Escape must not abandon it. Split out of the panel so the component stays inside the
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

/** Open/closed state for the Dock toggle, persisted like `useSessionsOpen`. */
export function useInboxOpen(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // Private mode: the choice lasts for this tab only.
    }
  }, [open])
  return [open, setOpen] as const
}

export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
