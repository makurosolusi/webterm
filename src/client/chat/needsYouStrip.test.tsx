/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '../ChatPanel'
import { ChatApiError } from '../chatApi'
import type { ChatClient } from './chatTypes'
import {
  DUP_ROWS, GATE, LEDGER, LEDGER_ROW, PERM, QUESTION, TASK_BROKEN, TASK_REVIEW, serveLedger,
} from './needsYou.fixtures'
import { INBOX_ITEMS_PATH, resetNeedsYou, useNeedsYouCount } from './needsYouApi'
import { NeedsYouStrip } from './needsYouStrip'
import { setNeedsYouExpanded } from '../secondarySideBar.store'

beforeEach(() => { resetNeedsYou(); setNeedsYouExpanded(false) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const head = () => screen.getByRole('button', { expanded: false })
const ALL = { items: [PERM, GATE, QUESTION, LEDGER], tasks: [...DUP_ROWS, LEDGER_ROW, TASK_REVIEW, TASK_BROKEN] }

describe('NeedsYouStrip', () => {
  it('collapsed: one line with the total and a chip per category, no row twice', async () => {
    serveLedger(ALL)
    render(<NeedsYouStrip />)
    // perm_1 + gate_1 + appr_1 (dialog row) = 3 approvals; q1 + task_1 = 2 review; task_2 broken.
    expect(await screen.findByText('6 need you')).toBeTruthy()
    const chips = Array.from(document.querySelectorAll('.needs-strip__chip')).map((c) => c.textContent)
    expect(chips).toEqual(['Approvals 3', 'Review 2', 'Broken 1'])
    expect(screen.queryByText('Run migration')).toBeNull()
  })

  it('is hidden when nothing waits', async () => {
    const ledger = serveLedger({ items: [], tasks: [] })
    const { container } = render(<NeedsYouStrip />)
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1))
    expect(container.innerHTML).toBe('')
    expect(ledger.posts).toHaveLength(0)
  })

  it('expands to the list and decides a gate inline', async () => {
    const ledger = serveLedger(ALL)
    render(<NeedsYouStrip />)
    await screen.findByText('6 need you')
    fireEvent.click(head())
    const card = (await screen.findByText('Run migration')).closest('.needs-card') as HTMLElement
    expect(screen.getByText('Fix login')).toBeTruthy()
    expect(screen.queryByText('Approval: deploy')).toBeNull() // the ledger approval is a dialog row, not a card
    fireEvent.click(within(card).getByRole('button', { name: 'Approve once' }))
    await waitFor(() => expect(ledger.posts[0]).toEqual({ url: `${INBOX_ITEMS_PATH}/act`, body: { id: 'gate_1', action: { type: 'approve' } } }))
    await waitFor(() => expect(screen.getByText('5 need you')).toBeTruthy())
  })

  it('a task row opens the APPROVE-phrase approval dialog', async () => {
    serveLedger(ALL)
    render(<NeedsYouStrip />)
    await screen.findByText('6 need you')
    fireEvent.click(head())
    const open = await screen.findByRole('button', { name: 'Review Fix login' }) as HTMLButtonElement
    await waitFor(() => expect(open.disabled).toBe(false)) // waits for the approved-list read (QC B4)
    fireEvent.click(open)
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Fix login')).toBeTruthy()
    expect(within(dialog).getByLabelText('Type APPROVE to confirm')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a task without a fence cannot be opened', async () => {
    serveLedger({ items: [], tasks: [{ ...TASK_REVIEW, fence: undefined }] })
    render(<NeedsYouStrip />)
    await screen.findByText('1 needs you')
    fireEvent.click(head())
    expect((screen.getByRole('button', { name: 'Review Fix login' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('useNeedsYouCount counts what the strip lists and shares its poller', async () => {
    serveLedger(ALL)
    const { result } = renderHook(() => [useNeedsYouCount(), useNeedsYouCount()])
    await waitFor(() => expect(result.current).toEqual([6, 6]))
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.startsWith('/api/approvals/inbox'))).toHaveLength(1)
  })
})

describe('NeedsYouStrip in ChatPanel', () => {
  it('renders when the Central chat API is unavailable (Central off)', async () => {
    serveLedger({ items: [GATE], tasks: [] })
    const client: ChatClient = {
      listConversations: vi.fn(async () => { throw new ChatApiError('not found', 404, 'not_found') }),
      createConversation: vi.fn(), listMessages: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(),
    }
    render(<ChatPanel open client={client} streamFactory={() => ({ close: () => {} })} />)
    expect(await screen.findByText('1 needs you')).toBeTruthy()
    fireEvent.click(head())
    expect(await screen.findByText('Run migration')).toBeTruthy()
  })
})
