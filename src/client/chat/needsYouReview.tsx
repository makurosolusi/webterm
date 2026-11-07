// Task / ledger-approval review from the "Needs you" strip: the Inbox's consent flow (typed
// APPROVE, server challenge, explicit Consume, task fence), moved here so it outlives InboxPanel.
// Opens the same `inboxApprovalDialog` through `InboxPanelDialog`. Owns no list: after every
// decision it re-reads the shared needs-you snapshot.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { inboxApi, inboxErrorMessage, isAbortError, type InboxClient, type InboxItem } from '../inboxApi'
import type { ReviewState } from '../inboxApprovalDialog'
import { InboxPanelDialog } from '../inboxPanelDialog'
import {
  approvalRequest, resumeApprovalFor, resumeReviewState, reviewBlockedReason, useApprovedApprovals, useInboxDialogKeys,
} from '../inboxPanelModel'
import { refreshNeedsYou } from './needsYouApi'

const BUSY: ReadonlySet<ReviewState['phase']> = new Set(['requesting', 'deciding', 'consuming'])

/** `open(item)` starts a review; `dialog` is the element to render (null when closed). */
export function useTaskReview(opts: { client?: InboxClient; now?: () => number } = {}) {
  const uid = useId()
  const client = useRef<InboxClient>(opts.client ?? inboxApi)
  client.current = opts.client ?? inboxApi
  const nowRef = useRef(opts.now ?? Date.now)
  nowRef.current = opts.now ?? Date.now
  const now = (): number => nowRef.current()
  // Re-read approved-unconsumed consent after each decision (the resume path, QC B4).
  const [approvedKey, setApprovedKey] = useState(0)
  const [state, setState] = useState<ReviewState | null>(null)
  const [clock, setClock] = useState(0)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const abort = useRef<AbortController | null>(null)
  const seq = useRef(0)
  const { approved, ready } = useApprovedApprovals({ enabled: true, client, refreshKey: approvedKey })
  const pending = state !== null && BUSY.has(state.phase)
  const patch = (next: Partial<ReviewState>): void => setState((s) => (s ? { ...s, ...next } : s))

  const close = useCallback(() => {
    seq.current += 1
    abort.current?.abort()
    setState(null)
  }, [])

  const open = state !== null
  useEffect(() => {
    if (!open) return
    setClock(now())
    const id = setInterval(() => setClock(now()), 1000)
    return () => clearInterval(id)
  }, [open])
  useEffect(() => () => abort.current?.abort(), [])
  useInboxDialogKeys({ open, dialogRef, pending, onClose: close })

  const begin = (queue: InboxItem[], index = 0): void => {
    const item = queue[index]
    if (!item || reviewBlockedReason(item) !== null) return
    const resume = resumeApprovalFor(item, approved)
    seq.current += 1
    abort.current?.abort()
    setClock(now())
    if (resume) return setState(resumeReviewState(resume, queue, index))
    // B4: a task approval is minted on decide; wait until we know none is approved-unconsumed.
    if (item.kind === 'task' && !ready) return
    const token = seq.current
    const controller = new AbortController()
    abort.current = controller
    const deferred = item.kind !== 'approval'
    setState({ queue, index, challenge: null, deferred, phase: deferred ? 'ready' : 'requesting', error: null, checked: false, text: '', approvedDigest: null })
    if (deferred) return
    client.current.getApprovalChallenge(item.id, { signal: controller.signal }).then(
      (challenge) => { if (seq.current === token) patch({ challenge, phase: 'ready' }) },
      (error: unknown) => { if (seq.current === token && !isAbortError(error)) patch({ phase: 'ready', error: inboxErrorMessage(error) }) },
    )
  }

  const decide = async (approve: boolean): Promise<void> => {
    const item = state?.queue[state.index]
    if (!state || !item) return
    const token = seq.current
    patch({ phase: 'deciding', error: null })
    try {
      let challenge = state.challenge
      if (!challenge) {
        challenge = await client.current.requestApproval(approvalRequest(item))
        if (seq.current !== token) return
        patch({ challenge, deferred: false })
      }
      const result = await client.current.decideApproval({ id: challenge.id, digest: challenge.digest, nonce: challenge.nonce, approve })
      if (seq.current !== token) return
      void refreshNeedsYou()
      setApprovedKey((k) => k + 1)
      if (!approve) return patch({ phase: 'rejected' })
      if (result.status !== 'approved') return patch({ phase: 'ready', error: `Approval was not granted (${result.status}).`, checked: false, text: '' })
      patch({ phase: 'approved', approvedDigest: challenge.digest })
    } catch (error) {
      if (seq.current !== token || isAbortError(error)) return
      patch({ phase: 'ready', error: inboxErrorMessage(error), checked: false, text: '' })
    }
  }

  const consume = async (): Promise<void> => {
    const challenge = state?.challenge
    const digest = state?.approvedDigest
    if (!challenge || !digest) return
    const token = seq.current
    patch({ phase: 'consuming', error: null })
    try {
      await client.current.consumeApproval({ id: challenge.id, digest })
      if (seq.current !== token) return
      void refreshNeedsYou()
      patch({ phase: 'consumed' })
    } catch (error) {
      if (seq.current !== token || isAbortError(error)) return
      patch({ phase: 'approved', error: inboxErrorMessage(error) })
    }
  }

  const advance = (): void => {
    if (state && state.index + 1 < state.queue.length) begin(state.queue, state.index + 1)
    else close()
  }

  const dialog = state && (
    <InboxPanelDialog state={state} clock={clock} pending={pending} uid={uid} dialogRef={dialogRef}
      onClose={close} onDecide={(approve) => void decide(approve)} onConsume={() => void consume()}
      onAdvance={advance} onRetry={() => begin(state.queue, state.index)}
      onChecked={(checked) => patch({ checked })} onText={(text) => patch({ text })} />
  )
  /** Why a row cannot open yet (no fence, or the approved list is still loading), else null. */
  const blocked = (item: InboxItem): string | null =>
    reviewBlockedReason(item) ?? (item.kind === 'task' && !ready ? 'Checking existing approvals…' : null)
  return { open: (item: InboxItem) => begin([item]), blocked, dialog }
}
