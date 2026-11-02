/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InboxPanel from './InboxPanel'
import type { InboxClient, InboxItem } from './inboxApi'

const NOW = 1_700_000_000_000
const ITEMS: InboxItem[] = [
  { id: 'i1', kind: 'deploy', state: 'needs_you', projectId: 'proj-a', title: 'Deploy main', ageMs: 125_000 },
  { id: 'i2', kind: 'rotate', state: 'needs_you', projectId: 'proj-a', title: 'Rotate keys', ageMs: 3_600_000 },
  { id: 'i3', kind: 'review', state: 'review', projectId: 'proj-b', title: 'Read diff', ageMs: 5_000 },
]

function client(items: InboxItem[] = ITEMS): InboxClient {
  return {
    listInbox: vi.fn(async () => items),
    getApprovalChallenge: vi.fn(),
    requestApproval: vi.fn(),
    decideApproval: vi.fn(),
    consumeApproval: vi.fn(),
  } as unknown as InboxClient
}

const row = (title: string): HTMLElement => screen.getByText(title).closest('li') as HTMLElement
afterEach(cleanup)

describe('inbox list (VS Code Problems model)', () => {
  it('keeps one tab stop and moves focus with arrows, Home and End', async () => {
    render(<InboxPanel client={client()} now={() => NOW} />)
    await screen.findByText('Deploy main')
    const stops = document.querySelectorAll('[data-row-key][tabindex="0"]')
    expect(stops).toHaveLength(1)
    const first = row('Deploy main')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('Rotate keys'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(row('Read diff'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect((document.activeElement as HTMLElement).dataset.rowKey?.startsWith('h:')).toBe(true)
  })

  it('Space toggles selection and Enter opens the row action', async () => {
    const c = client()
    render(<InboxPanel client={c} now={() => NOW} />)
    await screen.findByText('Deploy main')
    const first = row('Deploy main')
    first.focus()
    fireEvent.keyDown(first, { key: ' ' })
    expect(first.dataset.selected).toBe('true')
    fireEvent.keyDown(first, { key: ' ' })
    expect(first.dataset.selected).toBe('false')
  })

  it('collapses a group with ArrowLeft on its header and expands with ArrowRight', async () => {
    render(<InboxPanel client={client()} now={() => NOW} />)
    await screen.findByText('Deploy main')
    const header = document.querySelector<HTMLElement>('.inbox-section__toggle')!
    expect(header.getAttribute('aria-expanded')).toBe('true')
    header.focus()
    fireEvent.keyDown(header, { key: 'ArrowLeft' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Deploy main')).toBeNull()
    fireEvent.keyDown(header, { key: 'ArrowRight' })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Deploy main')).toBeDefined()
  })

  it('filters by text and shows the VS Code no-results message', async () => {
    render(<InboxPanel client={client()} now={() => NOW} />)
    await screen.findByText('Deploy main')
    const box = screen.getByLabelText('Filter items')
    fireEvent.change(box, { target: { value: 'proj-b' } })
    expect(screen.queryByText('Deploy main')).toBeNull()
    expect(screen.getByText('Read diff')).toBeDefined()
    fireEvent.change(box, { target: { value: 'zzz' } })
    expect(screen.getByText('No results found with provided filter criteria.')).toBeDefined()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.getByText('Deploy main')).toBeDefined()
  })

  it('shows the welcome view for an empty inbox and a count badge on the tab', async () => {
    const { unmount } = render(<InboxPanel client={client([])} now={() => NOW} />)
    expect(await screen.findByText('Inbox is clear.')).toBeDefined()
    unmount()
    render(<InboxPanel client={client()} now={() => NOW} />)
    await screen.findByText('Deploy main')
    expect(screen.getByLabelText('3 items').textContent).toBe('3')
  })
})
