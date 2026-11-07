/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatApprovalCard } from './chatApprovalCard'
import ChatConversationView, { type StreamFactory } from './chatConversation'
import type { ChatClient, ChatConversation, ChatStreamOptions } from './chatTypes'
import { GATE, PERM, QUESTION, serveLedger } from './needsYou.fixtures'
import { INBOX_ITEMS_PATH, resetNeedsYou } from './needsYouApi'

beforeEach(() => {
  resetNeedsYou()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ChatApprovalCard', () => {
  it('shows loading, then title, impact, summary and the allowed actions', async () => {
    serveLedger({ items: [GATE] })
    render(<ChatApprovalCard approvalId="gate_1" partState="awaiting_approval" />)
    expect(screen.getByRole('status').textContent).toBe('Loading approval…')
    expect(await screen.findByText('Run migration')).toBeTruthy()
    expect(screen.getByText('Changes the database · R1 · rewindable from a checkpoint')).toBeTruthy()
    expect(screen.getByText('Adds a column to users')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull()
  })

  it('Approve and Deny post act with the approvalId, then settle', async () => {
    const ledger = serveLedger({ items: [GATE, { ...GATE, id: 'gate_2', title: 'Second gate' }] })
    render(<><ChatApprovalCard approvalId="gate_1" /><ChatApprovalCard approvalId="gate_2" /></>)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Approve once' }))[0])
    await waitFor(() => expect(screen.getByLabelText('Run migration: Approved')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(screen.getByLabelText('Second gate: Denied')).toBeTruthy())
    expect(ledger.posts).toEqual([
      { url: `${INBOX_ITEMS_PATH}/act`, body: { id: 'gate_1', action: { type: 'approve' } } },
      { url: `${INBOX_ITEMS_PATH}/act`, body: { id: 'gate_2', action: { type: 'deny' } } },
    ])
  })

  it('shows deciding while the act is in flight', async () => {
    let release = (): void => {}
    serveLedger({ items: [GATE], actGate: new Promise<void>((r) => { release = r }) })
    const { container } = render(<ChatApprovalCard approvalId="gate_1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve once' }))
    await waitFor(() => expect(container.querySelector('[data-state="deciding"]')).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true)
    release()
    await waitFor(() => expect(screen.getByLabelText('Run migration: Approved')).toBeTruthy())
  })

  it('R3 keeps the typed APPROVE phrase for Approve and Always', async () => {
    const ledger = serveLedger({ items: [PERM] })
    render(<ChatApprovalCard approvalId="perm_1" />)
    const approve = await screen.findByRole('button', { name: 'Approve once' }) as HTMLButtonElement
    const always = screen.getByRole('button', { name: 'Always' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(always.disabled).toBe(true)
    const input = screen.getByLabelText('Type APPROVE to confirm')
    fireEvent.change(input, { target: { value: 'approve' } })
    expect(approve.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'APPROVE' } })
    expect(approve.disabled).toBe(false)
    // IconTooltip swaps its disabled wrapper for the live button: query again.
    fireEvent.click(screen.getByRole('button', { name: 'Always' }))
    await waitFor(() => expect(ledger.posts[0]?.body).toEqual({ id: 'perm_1', action: { type: 'always' } }))
  })

  it('a missing item is Expired; a settled part shows its outcome', async () => {
    serveLedger({ items: [] })
    render(<><ChatApprovalCard approvalId="gone" partState="awaiting_approval" /><ChatApprovalCard approvalId="x" partState="denied" /></>)
    expect(await screen.findByLabelText('Approval request: Expired')).toBeTruthy()
    expect(screen.getByLabelText('Approval request: Denied')).toBeTruthy()
  })

  it('a failed act shows the error and Retry re-sends the same action', async () => {
    const ledger = serveLedger({ items: [GATE], actReply: { status: 500, body: { error: 'boom' } } })
    render(<ChatApprovalCard approvalId="gate_1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
    ledger.actReply = null
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByLabelText('Run migration: Denied')).toBeTruthy())
    expect(ledger.posts.map((p) => p.body)).toEqual([
      { id: 'gate_1', action: { type: 'deny' } }, { id: 'gate_1', action: { type: 'deny' } },
    ])
  })

  it('a list that never loaded shows an error with Retry, not Expired', async () => {
    const ledger = serveLedger({ items: [GATE], itemsFail: true })
    render(<ChatApprovalCard approvalId="gate_1" />)
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
    ledger.itemsFail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Run migration')).toBeTruthy()
  })

  it('a race lost to another surface reads "Answered elsewhere"', async () => {
    serveLedger({ items: [GATE], actReply: { status: 409, body: { error: 'not_open' } } })
    render(<ChatApprovalCard approvalId="gate_1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve once' }))
    expect(await screen.findByLabelText('Run migration: Answered elsewhere')).toBeTruthy()
  })

  it('Edit sends the edited JSON; Reply sends text', async () => {
    const ledger = serveLedger({ items: [GATE, QUESTION] })
    render(<><ChatApprovalCard approvalId="gate_1" /><ChatApprovalCard approvalId="q1" /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit arguments'), { target: { value: '{"table":"orders"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve with edits' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByLabelText('Reply to the agent'), { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(ledger.posts).toHaveLength(2))
    expect(ledger.posts.map((p) => p.body)).toEqual([
      { id: 'gate_1', action: { type: 'edit', args: { table: 'orders' } } },
      { id: 'q1', action: { type: 'reply', text: 'main' } },
    ])
  })
})

describe('approval frames in the Central chat', () => {
  it('approval.requested renders a live card; approval.updated settles it', async () => {
    serveLedger({ items: [GATE] })
    const opened: ChatStreamOptions[] = []
    const factory: StreamFactory = (_id, opts) => { opened.push(opts); return { close: () => {} } }
    const client: ChatClient = {
      listConversations: vi.fn(), createConversation: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(),
      listMessages: vi.fn(async () => []),
    }
    const conversation: ChatConversation = {
      id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
      lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 1, title: null,
    }
    render(<ChatConversationView conversation={conversation} client={client} streamFactory={factory} />)
    await waitFor(() => expect(opened).toHaveLength(1))
    const frame = (seq: number, type: string, state: string) => act(() => opened[0].onEvent({
      seq, type, conversationId: conversation.id, turnId: 't1', createdAt: seq, payload: { approvalId: 'gate_1', state },
    }))
    frame(1, 'approval.requested', 'pending')
    expect(await screen.findByRole('button', { name: 'Approve once' })).toBeTruthy()
    frame(2, 'approval.updated', 'approved')
    expect(await screen.findByLabelText('Run migration: Approved')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull()
  })
})
