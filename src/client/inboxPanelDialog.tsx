// Approval-dialog presentation for `InboxPanel`. Split out so the container stays inside the
// repo's file-size budget, and so the consent surface keeps one owner for its countdown.
//
// The panel still owns the dialog state, its countdown clock, and every API call
// (decide/consume/advance). This module only derives what the dialog renders: the expiry
// remaining time and whether Approve is enabled.
import type { RefObject } from 'react'
import type { ReviewState } from './inboxApprovalDialog'
import { CONFIRM_PHRASE, InboxApprovalDialog } from './inboxApprovalDialog'

export interface InboxPanelDialogProps {
  state: ReviewState
  /** A request/decision/consume is in flight: Approve must stay disabled. */
  pending: boolean
  /** Panel's countdown clock (epoch ms), ticked once a second while a dialog is open. */
  clock: number
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

export function InboxPanelDialog(props: InboxPanelDialogProps): React.JSX.Element {
  const { state, clock, pending, uid, dialogRef } = props
  const challenge = state.challenge
  const remaining = challenge ? challenge.expiresAt - clock : 0
  const expired = challenge !== null && remaining <= 0
  const canApprove = !pending && !expired && state.checked && state.text === CONFIRM_PHRASE
  return (
    <InboxApprovalDialog
      state={state}
      challenge={challenge}
      deferred={state.deferred}
      remainingMs={remaining}
      expired={expired}
      pending={pending}
      canApprove={canApprove}
      uid={uid}
      dialogRef={dialogRef}
      onClose={props.onClose}
      onDecide={props.onDecide}
      onConsume={props.onConsume}
      onAdvance={props.onAdvance}
      onRetry={props.onRetry}
      onChecked={props.onChecked}
      onText={props.onText}
    />
  )
}
