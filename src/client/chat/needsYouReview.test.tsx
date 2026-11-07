/** @vitest-environment jsdom */
// The task / ledger-approval consent flow of the Needs-you strip (moved from the Inbox panel):
// typed APPROVE + checkbox, server challenge, explicit Consume, task fence, resume of an
// approved-but-unconsumed approval (QC B4), expiry countdown.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxApiError, type ApprovalChallenge, type ApprovedApproval, type InboxClient, type InboxItem } from '../inboxApi'
import { reviewBlockedReason } from '../inboxPanelModel'
import { serveLedger } from './needsYou.fixtures'
import { resetNeedsYou } from './needsYouApi'
import { useTaskReview } from './needsYouReview'

const NOW = 1_700_000_000_000 // test-only
const CHALLENGE: ApprovalChallenge = {
  id: 'ap-1', digest: 'abcdef1234567890'.repeat(4), nonce: 'nonce-1', expiresAt: NOW + 120_000, kind: 'deploy', projectId: 'proj-a',
}
const APPROVAL_ITEM: InboxItem = { id: CHALLENGE.id, kind: 'approval', state: 'needs_you', projectId: 'proj-a', title: 'Approve deploy', ageMs: 0 }
const TASK: InboxItem = { id: 't-review', kind: 'task', state: 'review', projectId: 'proj-a', title: 'Review task', ageMs: 0, fence: 7 }

function makeClient(over: Partial<InboxClient> = {}): InboxClient {
  return {
    listInbox: vi.fn(async () => []),
    listApproved: vi.fn(async () => []),
    getApprovalChallenge: vi.fn(async () => CHALLENGE),
    requestApproval: vi.fn(async () => CHALLENGE),
    decideApproval: vi.fn(async () => ({ id: CHALLENGE.id, status: 'approved' as const })),
    consumeApproval: vi.fn(async () => ({ ok: true })),
    ...over,
  }
}

function Harness(props: { client: InboxClient; items: InboxItem[]; now?: () => number }): React.JSX.Element {
  const review = useTaskReview({ client: props.client, now: props.now ?? (() => NOW) })
  return (
    <>
      {props.items.map((item) => (
        <button key={item.id} type="button" disabled={review.blocked(item) !== null} onClick={() => review.open(item)}>Review {item.title}</button>
      ))}
      {review.dialog}
    </>
  )
}

async function open(title: string): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: `Review ${title}` }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false)) // the approved-list read gates task rows
  fireEvent.click(button)
  return screen.findByRole('alertdialog')
}
const confirm = (): void => {
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
  fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
}
const approve = (): HTMLButtonElement => screen.getByRole('button', { name: /^Approve$/ }) as HTMLButtonElement

beforeEach(() => {
  resetNeedsYou()
  serveLedger({ items: [], tasks: [] }) // refreshNeedsYou after each decision
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Needs-you task review', () => {
  it('requires the checkbox AND the exact phrase before approving', async () => {
    const client = makeClient()
    render(<Harness client={client} items={[APPROVAL_ITEM]} />)
    await open('Approve deploy')
    expect(client.getApprovalChallenge).toHaveBeenCalledWith('ap-1', expect.anything())
    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(approve().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
    fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'approve' } })
    expect(approve().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
    expect(approve().disabled).toBe(false)
  })

  it('decides, offers Consume only after approval, and consumes with the digest', async () => {
    const client = makeClient()
    render(<Harness client={client} items={[APPROVAL_ITEM]} />)
    await open('Approve deploy')
    confirm()
    expect(screen.queryByRole('button', { name: 'Consume approval' })).toBeNull()
    fireEvent.click(approve())
    fireEvent.click(await screen.findByRole('button', { name: 'Consume approval' }))
    expect(client.decideApproval).toHaveBeenCalledWith(expect.objectContaining({ id: CHALLENGE.id, digest: CHALLENGE.digest, nonce: CHALLENGE.nonce, approve: true }))
    expect(await screen.findByText('Consumed. The action is approved.')).toBeTruthy()
    expect(client.consumeApproval).toHaveBeenCalledWith({ id: CHALLENGE.id, digest: CHALLENGE.digest })
  })

  it('rejects without any consume step', async () => {
    const client = makeClient({ decideApproval: vi.fn(async () => ({ id: CHALLENGE.id, status: 'rejected' as const })) })
    render(<Harness client={client} items={[APPROVAL_ITEM]} />)
    await open('Approve deploy')
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(await screen.findByText('Rejected. The action will not run.')).toBeTruthy()
    expect(client.decideApproval).toHaveBeenCalledWith(expect.objectContaining({ approve: false }))
    expect(screen.queryByRole('button', { name: 'Consume approval' })).toBeNull()
  })

  it('mints a task challenge with the task identity and fence only when a decision is pressed', async () => {
    const client = makeClient()
    render(<Harness client={client} items={[TASK]} />)
    const dialog = await open('Review task')
    expect(client.requestApproval).not.toHaveBeenCalled()
    confirm()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve$/ }))
    expect(await within(dialog).findByRole('button', { name: 'Consume approval' })).toBeTruthy()
    expect(client.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task', projectId: 'proj-a', request: expect.objectContaining({ itemId: 't-review', taskId: 't-review', fence: 7 }),
    }))
    expect(client.decideApproval).toHaveBeenCalledWith(expect.objectContaining({ id: CHALLENGE.id, digest: CHALLENGE.digest, approve: true }))
  })

  it('surfaces a digest mismatch and never offers Consume', async () => {
    const client = makeClient({ decideApproval: vi.fn(async () => { throw new InboxApiError('POST decide failed (409 digest_mismatch)', 409, 'digest_mismatch') }) })
    render(<Harness client={client} items={[APPROVAL_ITEM]} />)
    await open('Approve deploy')
    confirm()
    fireEvent.click(approve())
    expect((await screen.findByRole('alert')).textContent).toMatch(/action changed/i)
    expect(screen.queryByRole('button', { name: 'Consume approval' })).toBeNull()
    expect(approve().disabled).toBe(true)
  })

  it('resumes an approved-but-unconsumed task approval and consumes it only on click', async () => {
    const approved: ApprovedApproval = { id: 'ap-approved', projectId: 'proj-a', kind: 'task', taskId: TASK.id, fence: 7, digest: 'c'.repeat(64), expiresAt: NOW + 120_000 }
    const client = makeClient({ listApproved: vi.fn(async () => [approved]) })
    render(<Harness client={client} items={[TASK]} />)
    const dialog = await open('Review task')
    const consume = await within(dialog).findByRole('button', { name: 'Consume approval' })
    expect(client.consumeApproval).not.toHaveBeenCalled()
    expect(client.requestApproval).not.toHaveBeenCalled()
    fireEvent.click(consume)
    await within(dialog).findByText('Consumed. The action is approved.')
    expect(client.consumeApproval).toHaveBeenCalledWith({ id: approved.id, digest: approved.digest })
  })

  it('a task without a fence is blocked; other kinds never are', () => {
    expect(reviewBlockedReason(TASK)).toBeNull()
    expect(reviewBlockedReason({ ...TASK, fence: undefined })).toMatch(/no fence/i)
    expect(reviewBlockedReason({ ...TASK, kind: 'approval', fence: undefined })).toBeNull()
  })

  it('counts the challenge down and expires it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    render(<Harness client={makeClient()} items={[APPROVAL_ITEM]} now={Date.now} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Review Approve deploy' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('expires in 2:00')).toBeTruthy()
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByText('expires in 1:30')).toBeTruthy()
    act(() => vi.advanceTimersByTime(90_000))
    expect(screen.getByRole('alert').textContent).toMatch(/expired/i)
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Request new challenge' })).toBeTruthy()
  })

  it('closes on Escape without deciding anything', async () => {
    const client = makeClient()
    render(<Harness client={client} items={[TASK]} />)
    await open('Review task')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(client.decideApproval).not.toHaveBeenCalled()
  })
})
