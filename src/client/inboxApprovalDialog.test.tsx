/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRM_PHRASE, InboxApprovalDialog } from './inboxApprovalDialog'
import type { InboxApprovalDialogProps, ReviewState } from './inboxApprovalDialog'

afterEach(cleanup)

const baseState = (over: Partial<ReviewState> = {}): ReviewState => ({
  queue: [], index: 0, challenge: null, deferred: true, phase: 'ready', error: null,
  checked: false, text: '', approvedDigest: null, ...over,
})

const mount = (over: Partial<InboxApprovalDialogProps> = {}, state: Partial<ReviewState> = {}) => {
  const props: InboxApprovalDialogProps = {
    state: baseState(state), challenge: null, deferred: true, remainingMs: 0, expired: false,
    pending: false, canApprove: false, uid: 't', dialogRef: createRef<HTMLDivElement>(),
    onClose: vi.fn(), onDecide: vi.fn(), onConsume: vi.fn(), onAdvance: vi.fn(), onRetry: vi.fn(),
    onChecked: vi.fn(), onText: vi.fn(), ...over,
  }
  render(<InboxApprovalDialog {...props} />)
  return props
}

const buttonLabels = (): string[] =>
  Array.from(document.querySelectorAll('.approval-dialog__actions button')).map((b) => b.textContent ?? '')

describe('InboxApprovalDialog', () => {
  it('consent: primary Approve di tepi kanan (urutan macOS/Linux) dan checkbox fokus awal', async () => {
    mount()
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect(buttonLabels().map((t) => t.trim())).toEqual(['Reject', 'Approve'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox')))
  })

  it('Approve tetap nonaktif sampai canApprove, dan hanya memanggil onDecide(true)', () => {
    const props = mount({ canApprove: false })
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    cleanup()
    const ok = mount({ canApprove: true })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(ok.onDecide).toHaveBeenCalledWith(true)
    expect(props.onDecide).not.toHaveBeenCalled()
  })

  it('frasa konfirmasi tetap literal APPROVE dan input mengirim teks mentah', () => {
    expect(CONFIRM_PHRASE).toBe('APPROVE')
    const props = mount()
    fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'approve' } })
    expect(props.onText).toHaveBeenCalledWith('approve')
  })

  it('fase approved: Consume (primer) fokus awal, Close sekunder di kirinya', async () => {
    mount({}, { phase: 'approved' })
    expect(buttonLabels().map((t) => t.trim())).toEqual(['Close', 'Consume approval'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Consume approval' })))
  })
})
