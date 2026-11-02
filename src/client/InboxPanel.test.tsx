/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InboxPanel, { type InboxPanelProps } from './InboxPanel'
import { InboxApiError, type ApprovalChallenge, type InboxClient, type InboxItem } from './inboxApi'

const NOW = 1_700_000_000_000

const CHALLENGE: ApprovalChallenge = {
  id: 'ap-1',
  digest: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  nonce: 'nonce-1',
  expiresAt: NOW + 120_000,
  kind: 'deploy',
  projectId: 'proj-a',
}

const ITEMS: InboxItem[] = [
  { id: 'i1', kind: 'deploy', state: 'needs_you', projectId: 'proj-a', title: 'Deploy main', ageMs: 125_000 },
  { id: 'i2', kind: 'rotate', state: 'needs_you', projectId: 'proj-a', title: 'Rotate keys', ageMs: 3_600_000 },
  { id: 'i3', kind: 'review', state: 'review', projectId: 'proj-b', title: 'Read diff', ageMs: 5_000 },
  { id: 'i4', kind: 'ci', state: 'broken', projectId: 'proj-b', title: 'CI failed', ageMs: 90_000 },
]

/** `kind: "approval"`: the server already minted the challenge; opening only fetches it. */
const APPROVAL_ITEM: InboxItem = {
  id: CHALLENGE.id,
  kind: 'approval',
  state: 'needs_you',
  projectId: 'proj-a',
  title: 'Approve deploy',
  ageMs: 60_000,
}

/** A task review: no approval exists until the operator presses Approve/Reject. */
const TASK_ITEM: InboxItem = {
  id: 't-review',
  kind: 'task',
  state: 'review',
  projectId: 'proj-a',
  title: 'Review task',
  ageMs: 60_000,
  fence: 7,
}

function makeClient(overrides: Partial<InboxClient> = {}): InboxClient {
  return {
    listInbox: vi.fn(async () => ITEMS),
    getApprovalChallenge: vi.fn(async () => CHALLENGE),
    requestApproval: vi.fn(async () => CHALLENGE),
    decideApproval: vi.fn(async () => ({ id: CHALLENGE.id, status: 'approved' as const })),
    consumeApproval: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

function renderPanel(client: InboxClient, props: Partial<InboxPanelProps> = {}) {
  return render(<InboxPanel client={client} now={() => NOW} {...props} />)
}

async function openReview(title = 'Deploy main'): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Review ${title}` }))
  return screen.findByRole('alertdialog', { name: 'Approve action' })
}

function confirmTypedPhrase(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
  fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
}

function approveButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Approve$/ })
}

/** @testing-library/jest-dom is not installed here; assert the DOM property directly. */
function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('list states', () => {
  it('groups items into sections with counts and ages', async () => {
    renderPanel(makeClient())
    expect(await screen.findByText('Deploy main')).toBeDefined()
    expect(screen.getByRole('complementary', { name: 'Inbox' })).toBeDefined()
    const filters = within(screen.getByRole('group', { name: 'Filter inbox' }))
    expect(filters.getByRole('tab', { name: /^All/ }).textContent).toContain('4')
    expect(filters.getByRole('tab', { name: /^Needs you/ }).textContent).toContain('2')
    expect(filters.getByRole('tab', { name: /^Review/ }).textContent).toContain('1')
    expect(filters.getByRole('tab', { name: /^Broken/ }).textContent).toContain('1')
    expect(screen.getByText('2m ago')).toBeDefined()
  })

  it('shows the loading status before the list resolves', () => {
    renderPanel(makeClient({ listInbox: vi.fn(() => new Promise<InboxItem[]>(() => {})) }))
    expect(screen.getByRole('status').textContent).toContain('Loading inbox')
  })

  it('shows an empty state', async () => {
    renderPanel(makeClient({ listInbox: vi.fn(async () => []) }))
    expect(await screen.findByText('Inbox is clear.')).toBeDefined()
  })

  it('shows an alert and recovers on Retry', async () => {
    const listInbox = vi
      .fn<InboxClient['listInbox']>()
      .mockRejectedValueOnce(new InboxApiError('GET /api/inbox failed (500 http_500)', 500, 'http_500'))
      .mockResolvedValueOnce(ITEMS)
    renderPanel(makeClient({ listInbox }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('GET /api/inbox failed')
    // G-18: Retry is a secondary VS Code button, not the blue primary action.
    expect(within(alert).getByRole('button', { name: 'Retry' }).className).toContain('inbox-action--secondary')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Deploy main')).toBeDefined()
    expect(listInbox).toHaveBeenCalledTimes(2)
  })

  it('filters by section', async () => {
    renderPanel(makeClient())
    await screen.findByText('Deploy main')
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter inbox' })).getByRole('tab', { name: /^Review/ }))

    expect(screen.queryByText('Deploy main')).toBeNull()
    expect(screen.queryByText('Rotate keys')).toBeNull()
    expect(screen.getByText('Read diff')).toBeDefined()
    expect(screen.queryByRole('checkbox', { name: 'Select all in Needs you' })).toBeNull()
  })

  it('aborts the in-flight list request on unmount', async () => {
    const listInbox = vi.fn<InboxClient['listInbox']>((opts) => {
      return new Promise<InboxItem[]>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
    })
    const { unmount } = renderPanel(makeClient({ listInbox }))
    await waitFor(() => expect(listInbox).toHaveBeenCalled())
    const signal = listInbox.mock.calls[0]?.[0]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
  })
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

describe('expiry countdown', () => {
  it('ticks down and expires the challenge', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const client = makeClient({ listInbox: vi.fn(async () => [APPROVAL_ITEM]) })
    renderPanel(client, { now: Date.now })

    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Review Approve deploy' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('alertdialog')).toBeDefined()
    expect(screen.getByText('expires in 2:00')).toBeDefined()

    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByText('expires in 1:30')).toBeDefined()

    act(() => vi.advanceTimersByTime(90_000))
    expect(screen.getByText('expired')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toMatch(/expired/i)
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Request new challenge' })).toBeDefined()
  })

  it('flushes the dialog abort when the panel unmounts mid-challenge', async () => {
    const getApprovalChallenge = vi.fn<InboxClient['getApprovalChallenge']>(
      (_id, opts) =>
        new Promise<ApprovalChallenge>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )
    const client = makeClient({ listInbox: vi.fn(async () => [APPROVAL_ITEM]), getApprovalChallenge })
    const { unmount } = renderPanel(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Review Approve deploy' }))
    await waitFor(() => expect(getApprovalChallenge).toHaveBeenCalled())
    const signal = getApprovalChallenge.mock.calls[0]?.[1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})

describe('stylesheet scope', () => {
  it('has no global resets and every selector is inbox-scoped', () => {
    const css = readFileSync('src/client/inbox.css', 'utf8')
    expect(css).not.toMatch(/^\s*:root/m)
    expect(css).not.toMatch(/^\s*\*/m)
    expect(css).not.toMatch(/^\s*(html|body)\b/m)
    expect(css).toMatch(/@media \(max-width: 640px\)/)
  })

  it('keeps the narrow panel flush with the activity bar instead of floating beside a dock', () => {
    // The panel is a docked VS Code panel now (inboxPanelSurface.css); the old floating-dock
    // offsets (--dock-w / --float-gap) must not come back and push it off the left edge.
    const css = readFileSync('src/client/inbox.css', 'utf8')
    expect(css).not.toContain('--dock-w')
    expect(css).not.toContain('--float-gap')
    expect(readFileSync('src/client/inboxPanelSurface.css', 'utf8')).toMatch(
      /@media \(max-width: 640px\)[\s\S]*left: var\(--activity-bar-w/
    )
  })
})
