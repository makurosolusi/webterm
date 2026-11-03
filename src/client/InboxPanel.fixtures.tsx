import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import InboxPanel, { type InboxPanelProps } from './InboxPanel'
import type { ApprovalChallenge, InboxClient, InboxItem } from './inboxApi'

export const NOW = 1_700_000_000_000

export const CHALLENGE: ApprovalChallenge = {
  id: 'ap-1',
  digest: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  nonce: 'nonce-1',
  expiresAt: NOW + 120_000,
  kind: 'deploy',
  projectId: 'proj-a',
}

export const ITEMS: InboxItem[] = [
  { id: 'i1', kind: 'deploy', state: 'needs_you', projectId: 'proj-a', title: 'Deploy main', ageMs: 125_000 },
  { id: 'i2', kind: 'rotate', state: 'needs_you', projectId: 'proj-a', title: 'Rotate keys', ageMs: 3_600_000 },
  { id: 'i3', kind: 'review', state: 'review', projectId: 'proj-b', title: 'Read diff', ageMs: 5_000 },
  { id: 'i4', kind: 'ci', state: 'broken', projectId: 'proj-b', title: 'CI failed', ageMs: 90_000 },
]

/** `kind: "approval"`: the server already minted the challenge; opening only fetches it. */
export const APPROVAL_ITEM: InboxItem = {
  id: CHALLENGE.id,
  kind: 'approval',
  state: 'needs_you',
  projectId: 'proj-a',
  title: 'Approve deploy',
  ageMs: 60_000,
}

/** A task review: no approval exists until the operator presses Approve/Reject. */
export const TASK_ITEM: InboxItem = {
  id: 't-review',
  kind: 'task',
  state: 'review',
  projectId: 'proj-a',
  title: 'Review task',
  ageMs: 60_000,
  fence: 7,
}

export function makeClient(overrides: Partial<InboxClient> = {}): InboxClient {
  return {
    listInbox: vi.fn(async () => ITEMS),
    getApprovalChallenge: vi.fn(async () => CHALLENGE),
    requestApproval: vi.fn(async () => CHALLENGE),
    decideApproval: vi.fn(async () => ({ id: CHALLENGE.id, status: 'approved' as const })),
    consumeApproval: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

export function renderPanel(client: InboxClient, props: Partial<InboxPanelProps> = {}) {
  return render(<InboxPanel client={client} now={() => NOW} {...props} />)
}

export async function openReview(title = 'Deploy main'): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Review ${title}` }))
  return screen.findByRole('alertdialog', { name: 'Approve action' })
}

export function confirmTypedPhrase(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
  fireEvent.change(screen.getByLabelText('Type APPROVE to confirm'), { target: { value: 'APPROVE' } })
}

export function approveButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Approve$/ })
}

/** @testing-library/jest-dom is not installed here; assert the DOM property directly. */
export function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true
}
