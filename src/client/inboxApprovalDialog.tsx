// Approval dialog for InboxPanel. Split out so the panel stays inside the repo's file-size
// budget, and so the consent surface is one reviewable unit.
//
// It renders no decisions by itself: every button calls back. The caller owns the challenge and
// the API calls; this file owns only the literal consent UI.
import type { RefObject } from 'react'
import { Check, X } from 'lucide-react'
import type { ApprovalChallenge } from './inboxApi'

/** The exact text the operator must type. Not a regex, not case-folded: consent is literal. */
export const CONFIRM_PHRASE = 'APPROVE'

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

export function InboxApprovalDialog(props: InboxApprovalDialogProps): React.JSX.Element {
  const { state, challenge, deferred, remainingMs, expired, pending, canApprove, uid } = props
  const item = state.queue[state.index]
  const approved = state.phase === 'approved' || state.phase === 'consumed'
  const title = approved ? 'Approved action' : state.phase === 'rejected' ? 'Rejected action' : 'Approve action'
  // A deferred review has no digest/expiry yet; project and kind still describe the action so the
  // operator knows what they are consenting to before the server mints the challenge.
  const showConsent = state.phase === 'ready' && !expired && (deferred || challenge !== null)

  return (
    <div
      className="inbox-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) props.onClose()
      }}
    >
      <div
        ref={props.dialogRef}
        className="inbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-dialog-title`}
        aria-describedby={`${uid}-dialog-desc`}
      >
        <header className="inbox-dialog__head">
          <h3 className="inbox-dialog__title" id={`${uid}-dialog-title`}>{title}</h3>
          <button type="button" className="inbox-icon-btn" aria-label="Close approval dialog"
            disabled={pending} onClick={props.onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <p className="inbox-dialog__desc" id={`${uid}-dialog-desc`}>
          <strong>{item?.title}</strong>
          {state.queue.length > 1 && (
            <span className="inbox-dialog__step">Step {state.index + 1} of {state.queue.length}</span>
          )}
        </p>

        {(challenge || deferred) && (
          <dl className="inbox-dialog__facts">
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
                  <dd className={expired ? 'inbox-expired' : undefined} aria-live="polite">
                    {countdownLabel(remainingMs)}
                  </dd>
                </div>
              </>
            )}
          </dl>
        )}

        {(state.error || expired) && (
          <p className="inbox-dialog__error" role="alert">
            {state.error ?? 'This challenge expired. Request a new one.'}
          </p>
        )}

        {state.phase === 'requesting' && <p className="inbox-status" role="status">Preparing challenge…</p>}

        {showConsent && (
          <>
            <label className="inbox-consent">
              <input type="checkbox" checked={state.checked}
                onChange={(event) => props.onChecked(event.target.checked)} />
              <span>I understand this action cannot be undone from here.</span>
            </label>
            <label className="inbox-consent inbox-consent--type">
              <span>Type {CONFIRM_PHRASE} to confirm</span>
              <input type="text" className="inbox-input" aria-label={`Type ${CONFIRM_PHRASE} to confirm`}
                autoComplete="off" spellCheck={false} value={state.text}
                onChange={(event) => props.onText(event.target.value)} />
            </label>
            {state.text !== '' && state.text !== CONFIRM_PHRASE && (
              <p className="inbox-hint">Type exactly {CONFIRM_PHRASE} (uppercase).</p>
            )}
            <div className="inbox-dialog__actions">
              <button type="button" className="inbox-btn inbox-btn--approve"
                disabled={!canApprove} onClick={() => props.onDecide(true)}>
                <Check size={14} aria-hidden="true" /> Approve
              </button>
              <button type="button" className="inbox-btn inbox-btn--danger"
                disabled={pending} onClick={() => props.onDecide(false)}>
                Reject
              </button>
            </div>
          </>
        )}

        {state.phase === 'deciding' && <p className="inbox-status" role="status">Recording decision…</p>}

        {state.phase === 'approved' && (
          <>
            <p className="inbox-status inbox-status--ok" role="status">
              Decision recorded. Consume the approval to let the action run.
            </p>
            <div className="inbox-dialog__actions">
              <button type="button" className="inbox-btn inbox-btn--approve"
                disabled={pending || expired} onClick={props.onConsume}>
                Consume approval
              </button>
              <button type="button" className="inbox-btn inbox-btn--ghost" onClick={props.onClose}>Close</button>
            </div>
          </>
        )}

        {state.phase === 'rejected' && (
          <>
            <p className="inbox-status" role="status">Rejected. The action will not run.</p>
            <div className="inbox-dialog__actions">
              <button type="button" className="inbox-btn inbox-btn--ghost" onClick={props.onAdvance}>
                {state.index + 1 < state.queue.length ? 'Next' : 'Close'}
              </button>
            </div>
          </>
        )}

        {state.phase === 'consuming' && <p className="inbox-status" role="status">Consuming approval…</p>}

        {state.phase === 'consumed' && (
          <>
            <p className="inbox-status inbox-status--ok" role="status">Consumed. The action is approved.</p>
            <div className="inbox-dialog__actions">
              <button type="button" className="inbox-btn inbox-btn--ghost" onClick={props.onAdvance}>
                {state.index + 1 < state.queue.length ? 'Next' : 'Done'}
              </button>
            </div>
          </>
        )}

        {state.phase === 'ready' && !deferred && (!challenge || expired) && (
          <div className="inbox-dialog__actions">
            <button type="button" className="inbox-btn inbox-btn--ghost" onClick={props.onRetry}>
              Request new challenge
            </button>
            <button type="button" className="inbox-btn inbox-btn--ghost" onClick={props.onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}
