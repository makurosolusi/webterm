/** @vitest-environment jsdom */
// Fence contract between the server inbox projection and a task review request. Split from
// InboxPanel.test.tsx so that file stays inside the repo's test-size budget.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InboxPanel from './InboxPanel'
import type { ApprovalChallenge, InboxClient, InboxItem } from './inboxApi'
import { reviewBlockedReason } from './inboxPanelModel'

const NOW = 1_700_000_000_000

const CHALLENGE: ApprovalChallenge = {
  id: 'ap-1',
  digest: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  nonce: 'nonce-1',
  expiresAt: NOW + 120_000,
  kind: 'task',
  projectId: 'proj-a',
}

/** A task review row as `listInbox` parses it: the fence came from the server. */
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
    listInbox: vi.fn(async () => [TASK_ITEM]),
    getApprovalChallenge: vi.fn(async () => CHALLENGE),
    requestApproval: vi.fn(async () => CHALLENGE),
    decideApproval: vi.fn(async () => ({ id: CHALLENGE.id, status: 'approved' as const })),
    consumeApproval: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

function confirmTypedPhrase(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
  fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
}

afterEach(cleanup)

describe('task fence', () => {
  it('carries the fence through the minted challenge into the decision', async () => {
    const decideApproval = vi.fn<InboxClient['decideApproval']>(async () => ({
      id: CHALLENGE.id,
      status: 'approved' as const,
    }))
    const client = makeClient({ decideApproval })
    render(<InboxPanel client={client} now={() => NOW} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Review Review task' }))
    const dialog = await screen.findByRole('alertdialog')
    confirmTypedPhrase()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve$/ }))
    expect(await within(dialog).findByRole('button', { name: 'Consume approval' })).toBeDefined()

    expect(client.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        projectId: 'proj-a',
        request: expect.objectContaining({ taskId: 't-review', fence: 7 }),
      }),
      expect.anything()
    )
    // The server-minted challenge, not a locally invented one, is what the decision echoes.
    expect(decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CHALLENGE.id,
        digest: CHALLENGE.digest,
        nonce: CHALLENGE.nonce,
        approve: true,
      })
    )
  })

  it('disables Review on a task without a fence and explains why', async () => {
    const client = makeClient({
      listInbox: vi.fn(async () => [{ ...TASK_ITEM, id: 't-nofence', fence: undefined }]),
    })
    render(<InboxPanel client={client} now={() => NOW} />)

    const button = await screen.findByRole('button', { name: 'Review Review task' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.hasAttribute('title')).toBe(false)
    const trigger = button.parentElement!
    fireEvent.focus(trigger)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toMatch(/no fence/i)
    fireEvent.blur(trigger)

    fireEvent.click(button)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(client.requestApproval).not.toHaveBeenCalled()
  })

  it('reports the gate only for tasks, never for other kinds', () => {
    expect(reviewBlockedReason(TASK_ITEM)).toBeNull()
    expect(reviewBlockedReason({ ...TASK_ITEM, fence: undefined })).toMatch(/no fence/i)
    expect(reviewBlockedReason({ ...TASK_ITEM, kind: 'approval', fence: undefined })).toBeNull()
  })
})
