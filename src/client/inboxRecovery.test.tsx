/** @vitest-environment jsdom */
// QC B4 recovery path: an approved approval whose consume response was lost leaves the task in
// `claimed_done`, so the inbox shows it as review again. The panel must offer "Finish approval"
// (resume the existing consent) instead of minting a second approval, and must still consume only
// on an explicit click.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InboxPanel from './InboxPanel'
import { InboxApiError, type ApprovedApproval, type InboxClient, type InboxItem } from './inboxApi'

const NOW = 1_700_000_000_000
const DIGEST = 'c'.repeat(64)

const TASK: InboxItem = {
  id: 't-review',
  kind: 'task',
  state: 'review',
  projectId: 'proj-a',
  title: 'Review task',
  ageMs: 60_000,
  fence: 7,
}

/** Tooltip text of a row action: a blocked Review sits in a hover span, so focus its parent. */
const tipOf = (button: Element): string | null => {
  const trigger = button.parentElement!
  fireEvent.focus(trigger)
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? null
  fireEvent.blur(trigger)
  return text
}

const APPROVED: ApprovedApproval = {
  id: 'ap-approved',
  projectId: 'proj-a',
  kind: 'task',
  taskId: TASK.id,
  fence: 7,
  digest: DIGEST,
  expiresAt: NOW + 120_000,
}

/** Non-task rows keep their normal action even while the approved list is still loading. */
const DEPLOY: InboxItem = {
  id: 'i-deploy',
  kind: 'deploy',
  state: 'needs_you',
  projectId: 'proj-a',
  title: 'Deploy main',
  ageMs: 1_000,
}

function makeClient(overrides: Partial<InboxClient> = {}): InboxClient {
  return {
    listInbox: vi.fn(async () => [TASK]),
    listApproved: vi.fn(async () => [APPROVED]),
    getApprovalChallenge: vi.fn(),
    requestApproval: vi.fn(),
    decideApproval: vi.fn(),
    consumeApproval: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

function renderPanel(client: InboxClient) {
  return render(<InboxPanel client={client} now={() => NOW} />)
}

async function openResume(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Finish approval for Review task' }))
  return screen.findByRole('alertdialog', { name: 'Approved action' })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** @testing-library/jest-dom is not installed here; assert the DOM property directly. */
function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true
}

describe('approved-but-unconsumed resume', () => {
  it('offers Finish approval and consumes the existing approval only on click', async () => {
    const client = makeClient()
    renderPanel(client)

    // The stale approval replaces Review: a second approval would duplicate consent.
    const finish = await screen.findByRole('button', { name: 'Finish approval for Review task' })
    expect(screen.queryByRole('button', { name: 'Review Review task' })).toBeNull()
    expect(client.requestApproval).not.toHaveBeenCalled()
    expect(client.consumeApproval).not.toHaveBeenCalled()

    fireEvent.click(finish)
    const dialog = await screen.findByRole('alertdialog', { name: 'Approved action' })
    // Opening the dialog is not consent: nothing is consumed or decided on render.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Consume approval' })).toBeDefined())
    expect(client.consumeApproval).not.toHaveBeenCalled()
    expect(client.decideApproval).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Consume approval' }))
    await within(dialog).findByText('Consumed. The action is approved.')
    expect(client.consumeApproval).toHaveBeenCalledWith({ id: APPROVED.id, digest: DIGEST })
    expect(client.requestApproval).not.toHaveBeenCalled()
  })

  it('refreshes the inbox and the approved list after consuming', async () => {
    let items: InboxItem[] = [TASK]
    let approved: ApprovedApproval[] = [APPROVED]
    const listInbox = vi.fn(async () => [...items])
    const listApproved = vi.fn(async () => [...approved])
    const client = makeClient({
      listInbox,
      listApproved,
      consumeApproval: vi.fn(async () => {
        // The server verifies the task at consume time, so the row leaves the review list.
        items = []
        approved = []
        return { ok: true }
      }),
    })
    renderPanel(client)
    const dialog = await openResume()

    expect(listInbox).toHaveBeenCalledTimes(1)
    expect(listApproved).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Consume approval' }))
    await within(dialog).findByText('Consumed. The action is approved.')

    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listApproved).toHaveBeenCalledTimes(2))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('Inbox is clear.')).toBeDefined()
  })

  it('keeps the normal Review action when the approved fence does not match the row', async () => {
    const client = makeClient({ listApproved: vi.fn(async () => [{ ...APPROVED, fence: 8 }]) })
    renderPanel(client)

    expect(await screen.findByRole('button', { name: 'Review Review task' })).toBeDefined()
    await waitFor(() => expect(client.listApproved).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Finish approval/ })).toBeNull()
  })

  it('keeps the normal Review action when the approved project differs', async () => {
    const client = makeClient({ listApproved: vi.fn(async () => [{ ...APPROVED, projectId: 'proj-b' }]) })
    renderPanel(client)

    expect(await screen.findByRole('button', { name: 'Review Review task' })).toBeDefined()
    await waitFor(() => expect(client.listApproved).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Finish approval/ })).toBeNull()
  })

  it('ignores an approved list that fails to load instead of blocking the inbox', async () => {
    const listApproved = vi.fn<NonNullable<InboxClient['listApproved']>>(async () => {
      throw new InboxApiError('GET /api/approvals failed (500 http_500)', 500, 'http_500')
    })
    const client = makeClient({ listApproved })
    renderPanel(client)

    expect(await screen.findByRole('button', { name: 'Review Review task' })).toBeDefined()
    await waitFor(() => expect(listApproved).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: /Finish approval/ })).toBeNull()
    // A failed read still settles readiness: Review must not stay disabled forever.
    await waitFor(() =>
      expect(isDisabled(screen.getByRole('button', { name: 'Review Review task' }))).toBe(false)
    )
  })

  it('resumes a fence-less approval by task and project', async () => {
    const client = makeClient({
      listApproved: vi.fn(async () => [{ ...APPROVED, fence: undefined }]),
    })
    renderPanel(client)

    expect(await screen.findByRole('button', { name: 'Finish approval for Review task' })).toBeDefined()
  })

  it('gates a task Review action until the approved list settles', async () => {
    let release: (rows: ApprovedApproval[]) => void = () => {}
    const listApproved = vi.fn<NonNullable<InboxClient['listApproved']>>(
      () => new Promise<ApprovedApproval[]>((resolve) => { release = resolve })
    )
    const client = makeClient({ listApproved })
    renderPanel(client)

    // The inbox itself is not blocked: the row is there while the resume read is in flight.
    expect(await screen.findByText('Review task')).toBeDefined()
    const review = screen.getByRole('button', { name: 'Review Review task' })
    expect(isDisabled(review)).toBe(true)
    expect(review.hasAttribute('title')).toBe(false)
    expect(tipOf(review)).toBe('Checking existing approvals…')
    fireEvent.click(review)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(client.requestApproval).not.toHaveBeenCalled()

    await act(async () => release([]))
    await waitFor(() =>
      expect(isDisabled(screen.getByRole('button', { name: 'Review Review task' }))).toBe(false)
    )
    expect(tipOf(screen.getByRole('button', { name: 'Review Review task' }))).toBeNull()
  })

  it('leaves non-task rows reviewable while the approved list is pending', async () => {
    const client = makeClient({
      listInbox: vi.fn(async () => [DEPLOY]),
      listApproved: vi.fn(() => new Promise<ApprovedApproval[]>(() => {})),
    })
    renderPanel(client)

    const review = await screen.findByRole('button', { name: 'Review Deploy main' })
    expect(isDisabled(review)).toBe(false)
    expect(tipOf(review)).toBeNull()
  })

  it('re-gates a task row when the panel is closed and reopened', async () => {
    let release: (rows: ApprovedApproval[]) => void = () => {}
    const settled = makeClient({ listApproved: vi.fn(async () => []) })
    const reopened = makeClient({
      listApproved: vi.fn<NonNullable<InboxClient['listApproved']>>(
        () => new Promise<ApprovedApproval[]>((resolve) => { release = resolve })
      ),
    })
    const view = render(<InboxPanel client={settled} now={() => NOW} open />)
    const first = await screen.findByRole('button', { name: 'Review Review task' })
    await waitFor(() => expect(isDisabled(first)).toBe(false))

    view.rerender(<InboxPanel client={settled} now={() => NOW} open={false} />)
    expect(screen.queryByRole('button', { name: 'Review Review task' })).toBeNull()

    // The previous open's readiness must not leak into the new one: the fresh read is unanswered.
    view.rerender(<InboxPanel client={reopened} now={() => NOW} open />)
    const gated = await screen.findByRole('button', { name: 'Review Review task' })
    expect(isDisabled(gated)).toBe(true)
    expect(tipOf(gated)).toBe('Checking existing approvals…')
    fireEvent.click(gated)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(reopened.requestApproval).not.toHaveBeenCalled()

    await act(async () => release([]))
    await waitFor(() =>
      expect(isDisabled(screen.getByRole('button', { name: 'Review Review task' }))).toBe(false)
    )
  })
})
