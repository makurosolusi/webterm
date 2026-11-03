/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError, type InboxClient, type InboxItem } from './inboxApi'
import { APPROVAL_ITEM, CHALLENGE, TASK_ITEM, approveButton, confirmTypedPhrase, isDisabled, makeClient, openReview, renderPanel } from './InboxPanel.fixtures'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('approval flow', () => {
  it('requires the checkbox AND the exact phrase before approving', async () => {
    const client = makeClient()
    renderPanel(client)
    const dialog = await openReview()

    // Deferred review: the facts describe the action, but no challenge exists yet.
    expect(within(dialog).getByText('proj-a')).toBeDefined()
    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(isDisabled(approveButton())).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
    expect(isDisabled(approveButton())).toBe(true)

    fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'yes' } })
    expect(isDisabled(approveButton())).toBe(true)
    expect(screen.getByText(/Type exactly APPROVE/)).toBeDefined()

    fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'approve' } })
    expect(isDisabled(approveButton())).toBe(true)
    expect(client.decideApproval).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
    expect(isDisabled(approveButton())).toBe(false)
  })

  it('decides, then offers Consume only after approval, and consumes with the digest', async () => {
    let items: InboxItem[] = [APPROVAL_ITEM]
    const client = makeClient({
      listInbox: vi.fn(async () => [...items]),
      consumeApproval: vi.fn(async () => {
        items = []
        return { ok: true }
      }),
    })
    renderPanel(client)
    await openReview('Approve deploy')
    confirmTypedPhrase()

    expect(screen.queryByRole('button', { name: 'Consume approval' })).toBeNull()
    fireEvent.click(approveButton())

    expect(await screen.findByRole('button', { name: 'Consume approval' })).toBeDefined()
    expect(client.decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: CHALLENGE.id, digest: CHALLENGE.digest, nonce: CHALLENGE.nonce, approve: true })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Consume approval' }))
    expect(await screen.findByText('Consumed. The action is approved.')).toBeDefined()
    expect(client.consumeApproval).toHaveBeenCalledWith({ id: CHALLENGE.id, digest: CHALLENGE.digest })
    // The panel re-reads the server list after the decision and after consuming instead of
    // trusting local state.
    await waitFor(() => expect(client.listInbox).toHaveBeenCalledTimes(3))

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.queryByText('Approve deploy')).toBeNull()
  })

  it('rejects without any consume step and refreshes the list immediately', async () => {
    let items: InboxItem[] = [APPROVAL_ITEM]
    const client = makeClient({
      listInbox: vi.fn(async () => [...items]),
      decideApproval: vi.fn(async () => {
        items = []
        return { id: CHALLENGE.id, status: 'rejected' as const }
      }),
    })
    renderPanel(client)
    await openReview('Approve deploy')

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(await screen.findByText('Rejected. The action will not run.')).toBeDefined()
    expect(client.decideApproval).toHaveBeenCalledWith(expect.objectContaining({ approve: false }))
    expect(screen.queryByRole('button', { name: 'Consume approval' })).toBeNull()
    // The refresh is a refreshKey bump, so the second list read lands on the next render.
    await waitFor(() => expect(client.listInbox).toHaveBeenCalledTimes(2))
    // The cleared row is gone from the list (the dialog still describes what was rejected).
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review Approve deploy' })).toBeNull())
  })

  it('only fetches the existing challenge for an approval item', async () => {
    const client = makeClient({ listInbox: vi.fn(async () => [APPROVAL_ITEM]) })
    renderPanel(client)
    const dialog = await openReview('Approve deploy')

    expect(client.getApprovalChallenge).toHaveBeenCalledWith('ap-1', expect.anything())
    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(within(dialog).getByText(/abcdef123456…/)).toBeDefined()
    expect(within(dialog).getByText('expires in 2:00')).toBeDefined()
  })

  it('creates no server approval on open and leaves the queue untouched on Escape', async () => {
    const client = makeClient()
    renderPanel(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Review Deploy main' }))
    await screen.findByRole('alertdialog')

    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(client.getApprovalChallenge).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(client.decideApproval).not.toHaveBeenCalled()
  })

  it('mints a task challenge with the task identity only when a decision is pressed', async () => {
    const client = makeClient({ listInbox: vi.fn(async () => [TASK_ITEM]) })
    renderPanel(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Review Review task' }))
    const dialog = await screen.findByRole('alertdialog')

    expect(client.requestApproval).not.toHaveBeenCalled()
    confirmTypedPhrase()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve$/ }))
    expect(await within(dialog).findByRole('button', { name: 'Consume approval' })).toBeDefined()
    expect(client.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        projectId: 'proj-a',
        request: expect.objectContaining({ itemId: 't-review', taskId: 't-review', fence: 7 }),
      }),
      expect.anything()
    )
  })

  it('mints the task challenge when the approved list has no matching consent', async () => {
    const client = makeClient({
      listInbox: vi.fn(async () => [TASK_ITEM]),
      listApproved: vi.fn(async () => []),
    })
    renderPanel(client)
    const review = await screen.findByRole('button', { name: 'Review Review task' })
    // The approved-list read gates minting, so wait for it to settle before opening the dialog.
    await waitFor(() => expect(isDisabled(review)).toBe(false))
    fireEvent.click(review)
    const dialog = await screen.findByRole('alertdialog')
    expect(screen.queryByRole('button', { name: /Finish approval/ })).toBeNull()

    confirmTypedPhrase()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve$/ }))
    expect(await within(dialog).findByRole('button', { name: 'Consume approval' })).toBeDefined()
    expect(client.requestApproval).toHaveBeenCalledTimes(1)
  })

  it('never hides a still-listed task row after consuming its approval', async () => {
    // The server has not transitioned the task (P3 server gap): the row must stay visible
    // instead of being hidden locally by the task id.
    const client = makeClient({ listInbox: vi.fn(async () => [TASK_ITEM]) })
    renderPanel(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Review Review task' }))
    const dialog = await screen.findByRole('alertdialog')
    confirmTypedPhrase()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve$/ }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Consume approval' }))
    await within(dialog).findByText('Consumed. The action is approved.')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByText('Review task')).toBeDefined()
  })

  it('surfaces a digest/nonce mismatch, clears consent and never offers Consume', async () => {
    const decideApproval = vi
      .fn<InboxClient['decideApproval']>()
      .mockRejectedValue(new InboxApiError('POST decide failed (409 digest_mismatch)', 409, 'digest_mismatch'))
    const client = makeClient({ decideApproval })
    renderPanel(client)
    await openReview()
    confirmTypedPhrase()
    fireEvent.click(approveButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/action changed/i)
    expect(screen.queryByRole('button', { name: 'Consume approval' })).toBeNull()
    expect(isDisabled(approveButton())).toBe(true)
  })

  it('disables every dialog control while the decision is in flight', async () => {
    let release: (value: { id: string; status: 'approved' }) => void = () => {}
    const decideApproval = vi.fn<InboxClient['decideApproval']>(
      () => new Promise((resolve) => { release = resolve })
    )
    renderPanel(makeClient({ decideApproval }))
    await openReview()
    confirmTypedPhrase()
    fireEvent.click(approveButton())

    expect(await screen.findByText('Recording decision…')).toBeDefined()
    expect(isDisabled(screen.getByRole('button', { name: 'Close approval dialog' }))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()

    await act(async () => release({ id: CHALLENGE.id, status: 'approved' }))
    expect(await screen.findByRole('button', { name: 'Consume approval' })).toBeDefined()
  })

  it('closes on Escape and returns focus to the Review button', async () => {
    renderPanel(makeClient())
    const trigger = await screen.findByRole('button', { name: 'Review Deploy main' })
    trigger.focus()
    fireEvent.click(trigger)
    await screen.findByRole('alertdialog')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('calls onClose on panel Escape only when no dialog is open', async () => {
    const onClose = vi.fn()
    renderPanel(makeClient(), { onClose })
    await screen.findByText('Deploy main')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reviews a selected group one challenge at a time', async () => {
    const client = makeClient()
    renderPanel(client)
    await screen.findByText('Deploy main')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all in Needs you' }))
    expect(screen.getByText('2 selected')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Review selected' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Step 1 of 2')).toBeDefined()
    // A group review is deferred too: opening the first row mints nothing.
    expect(client.requestApproval).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))
    expect(client.requestApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'deploy', projectId: 'proj-a' }),
      expect.anything()
    )
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Next' }))
    await within(dialog).findByText('Step 2 of 2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))
    await waitFor(() =>
      expect(client.requestApproval).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'rotate', projectId: 'proj-a' }),
        expect.anything()
      )
    )
  })
})
