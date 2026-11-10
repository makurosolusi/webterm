// Approval dialog for the Needs-you task review (`chat/needsYouReview`). Split out so the hook stays inside the repo's file-size
// budget, and so the consent surface is one reviewable unit.
//
// It renders no decisions by itself: every button calls back. The caller owns the challenge and
// the API calls; this file owns only the literal consent UI.
import { useEffect } from 'react'
import type { ReactNode, RefObject } from 'react'
import { arrangeDialogButtons } from '@/components/vscode/vscodeDialogButtons'
import { IconTooltip } from '@/components/ui/icon-button'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import type { ApprovalChallenge } from './inboxApi'
import { CONFIRM_PHRASE } from '../shared/approvalConfirm'
import './inboxApprovalDialog.css'

export { CONFIRM_PHRASE }

export type ReviewPhase =
  | 'requesting'
  | 'ready'
  | 'deciding'
  | 'approved'
  | 'rejected'
  | 'consuming'
  | 'consumed'

export interface ReviewState {
  queue: import('./inboxApi').InboxItem[]
  index: number
  challenge: ApprovalChallenge | null
  /** No server approval exists yet: it is minted when Approve/Reject is pressed. */
  deferred: boolean
  phase: ReviewPhase
  error: string | null
  checked: boolean
  text: string
  approvedDigest: string | null
}

export interface InboxApprovalDialogProps {
  state: ReviewState
  challenge: ApprovalChallenge | null
  /** True for a task review whose challenge is created on the first decision. */
  deferred: boolean
  remainingMs: number
  expired: boolean
  pending: boolean
  canApprove: boolean
  uid: string
  dialogRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  onDecide: (approve: boolean) => void
  onConsume: () => void
  onAdvance: () => void
  onRetry: () => void
  onChecked: (checked: boolean) => void
  onText: (text: string) => void
}

export function countdownLabel(remainingMs: number): string {
  if (remainingMs <= 0) return 'expired'
  const total = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `expires in ${minutes}:${String(seconds).padStart(2, '0')}`
}

export function shortDigest(digest: string): string {
  return digest.length <= 12 ? digest : `${digest.slice(0, 12)}…`
}

/** Marks the element that gets focus when a phase renders (the VS Code dialog's primary action). */
const AUTOFOCUS_ATTR = 'data-approval-autofocus'

/**
 * Button row in VS Code order: Windows keeps the primary first, macOS/Linux put it on the trailing
 * edge. `cancelIndex` marks a Close/Cancel button; without one the buttons are plain alternatives.
 */
function Actions({ buttons, cancelIndex }: { buttons: ReactNode[]; cancelIndex?: number }) {
  return <div className="approval-dialog__actions">{arrangeDialogButtons(buttons, cancelIndex)}</div>
}

export function InboxApprovalDialog(props: InboxApprovalDialogProps): React.JSX.Element {
  const { state, challenge, deferred, remainingMs, expired, pending, canApprove, uid } = props
  const item = state.queue[state.index]
  const approved = state.phase === 'approved' || state.phase === 'consumed'
  const title = approved ? 'Approved action' : state.phase === 'rejected' ? 'Rejected action' : 'Approve action'
  // A deferred review has no digest/expiry yet; project and kind still describe the action so the
  // operator knows what they are consenting to before the server mints the challenge.
  const showConsent = state.phase === 'ready' && !expired && (deferred || challenge !== null)

  const focusTarget = (): HTMLElement | null =>
    props.dialogRef.current?.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTR}]:not(:disabled)`) ?? null

  // Phases swap the body (and drop whatever had focus), so each phase hands focus back to its own
  // primary control. The consent phase targets the checkbox, not Approve: Approve stays disabled
  // until the operator has ticked the box and typed the phrase.
  useEffect(() => { focusTarget()?.focus() }, [state.phase, expired])

  return (
    <AlertDialog open onOpenChange={(open) => {
      if (!open && !pending) props.onClose()
    }}>
      <AlertDialogContent
        forceMount
        ref={props.dialogRef}
        className="approval-dialog"
        onOpenAutoFocus={(event) => {
          const target = focusTarget()
          if (!target) return
          event.preventDefault()
          target.focus()
        }}
        aria-labelledby={`${uid}-dialog-title`}
        aria-describedby={`${uid}-dialog-desc`}
      >
        <header className="approval-dialog__head">
          <AlertDialogTitle className="approval-dialog__title" id={`${uid}-dialog-title`}>{title}</AlertDialogTitle>
          <IconTooltip label="Close approval dialog" disabled={pending} disabledReason="a decision is being sent">
            <button type="button" className="approval-dialog__close" aria-label="Close approval dialog"
              disabled={pending} onClick={props.onClose}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </IconTooltip>
        </header>

        <AlertDialogDescription className="approval-dialog__desc" id={`${uid}-dialog-desc`}>
          <strong>{item?.title}</strong>
          {state.queue.length > 1 && (
            <span className="approval-dialog__step">Step {state.index + 1} of {state.queue.length}</span>
          )}
        </AlertDialogDescription>

        {(challenge || deferred) && (
          <dl className="approval-dialog__facts">
            <div>
              <dt>Project</dt>
              <dd>{challenge?.projectId || item?.projectId}</dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>{challenge?.kind || item?.kind}</dd>
            </div>
            {challenge && (
              <>
                <div>
                  <dt>Digest</dt>
                  <dd><code title={challenge.digest}>{shortDigest(challenge.digest)}</code></dd>
                </div>
                <div>
                  <dt>Expiry</dt>
                  <dd className={expired ? 'approval-dialog__expired' : undefined} aria-live="polite">
                    {countdownLabel(remainingMs)}
                  </dd>
                </div>
              </>
            )}
          </dl>
        )}

        {(state.error || expired) && (
          <p className="approval-dialog__error" role="alert">
            <span className="codicon codicon-error" aria-hidden="true" />
            <span>{state.error ?? 'This challenge expired. Request a new one.'}</span>
          </p>
        )}

        {state.phase === 'requesting' && <p className="inbox-status" role="status">Preparing challenge…</p>}

        {showConsent && (
          <>
            <label className="approval-dialog__consent">
              <input type="checkbox" className="approval-dialog__check" checked={state.checked} {...{ [AUTOFOCUS_ATTR]: '' }}
                onChange={(event) => props.onChecked(event.target.checked)} />
              <span>I understand this action cannot be undone from here.</span>
            </label>
            <label className="approval-dialog__consent approval-dialog__consent--type">
              <span>Type {CONFIRM_PHRASE} to confirm</span>
              <input type="text" className="approval-dialog__input" aria-label={`Type ${CONFIRM_PHRASE} to confirm`}
                autoComplete="off" spellCheck={false} value={state.text}
                onChange={(event) => props.onText(event.target.value)} />
            </label>
            {state.text !== '' && state.text !== CONFIRM_PHRASE && (
              <p className="approval-dialog__hint">
                <span className="codicon codicon-warning" aria-hidden="true" />
                <span>Type exactly {CONFIRM_PHRASE} (uppercase).</span>
              </p>
            )}
            <Actions buttons={[
              <button key="approve" type="button" className="approval-dialog__btn"
                disabled={!canApprove} onClick={() => props.onDecide(true)}>
                Approve
              </button>,
              <button key="reject" type="button" className="approval-dialog__btn approval-dialog__btn--secondary"
                disabled={pending} onClick={() => props.onDecide(false)}>
                Reject
              </button>,
            ]} />
          </>
        )}

        {state.phase === 'deciding' && <p className="inbox-status" role="status">Recording decision…</p>}

        {state.phase === 'approved' && (
          <>
            <p className="inbox-status inbox-status--ok" role="status">
              Decision recorded. Consume the approval to let the action run.
            </p>
            <Actions cancelIndex={1} buttons={[
              <button key="consume" type="button" className="approval-dialog__btn" {...{ [AUTOFOCUS_ATTR]: '' }}
                disabled={pending || expired} onClick={props.onConsume}>
                Consume approval
              </button>,
              <button key="close" type="button" className="approval-dialog__btn approval-dialog__btn--secondary"
                onClick={props.onClose}>Close</button>,
            ]} />
          </>
        )}

        {state.phase === 'rejected' && (
          <>
            <p className="inbox-status" role="status">Rejected. The action will not run.</p>
            <Actions buttons={[
              <button key="advance" type="button" className="approval-dialog__btn approval-dialog__btn--secondary"
                {...{ [AUTOFOCUS_ATTR]: '' }} onClick={props.onAdvance}>
                {state.index + 1 < state.queue.length ? 'Next' : 'Close'}
              </button>,
            ]} />
          </>
        )}

        {state.phase === 'consuming' && <p className="inbox-status" role="status">Consuming approval…</p>}

        {state.phase === 'consumed' && (
          <>
            <p className="inbox-status inbox-status--ok" role="status">Consumed. The action is approved.</p>
            <Actions buttons={[
              <button key="advance" type="button" className="approval-dialog__btn approval-dialog__btn--secondary"
                {...{ [AUTOFOCUS_ATTR]: '' }} onClick={props.onAdvance}>
                {state.index + 1 < state.queue.length ? 'Next' : 'Done'}
              </button>,
            ]} />
          </>
        )}

        {state.phase === 'ready' && !deferred && (!challenge || expired) && (
          <Actions cancelIndex={1} buttons={[
            <button key="retry" type="button" className="approval-dialog__btn" {...{ [AUTOFOCUS_ATTR]: '' }}
              onClick={props.onRetry}>
              Request new challenge
            </button>,
            <button key="close" type="button" className="approval-dialog__btn approval-dialog__btn--secondary"
              onClick={props.onClose}>Close</button>,
          ]} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
