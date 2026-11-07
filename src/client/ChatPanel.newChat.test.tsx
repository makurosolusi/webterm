/** @vitest-environment jsdom */
// "New chat" (+) and History switching in the Central chat side bar (compact, embedded mount).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel'
import { ChatApiError } from './chatApi'
import type { ChatClient, ChatConversation, ChatMessage } from './chat/chatTypes'
import type { StreamFactory } from './chat/chatConversation'

const NOW = Date.now()
const OLD: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 3, lastMessageSeq: 2, updatedAt: NOW - 2 * 3_600_000, title: 'Old question',
}
const OTHER: ChatConversation = {
  id: 'central:chat:abc', scope: 'chat:abc', projectId: null, activeTurnId: null,
  lastEventSeq: 1, lastMessageSeq: 2, updatedAt: NOW - 5 * 60_000, title: 'Release plan',
}
const CREATED: ChatConversation = {
  id: 'central:chat:new', scope: 'chat:new', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: NOW, title: null,
}
const OLD_MESSAGE: ChatMessage = {
  id: 'm1', conversationId: OLD.id, role: 'human', parts: [{ type: 'text', text: 'hello from before' }],
  state: 'complete', seq: 1,
} as ChatMessage

function makeClient(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    listConversations: vi.fn(async () => [OTHER, OLD]),
    createConversation: vi.fn(async () => CREATED),
    listMessages: vi.fn(async (id: string) => (id === OLD.id ? [OLD_MESSAGE] : [])),
    sendMessage: vi.fn(async () => ({ messageId: 'm9', seq: 1, turnId: 't9', status: 'queued' as const })),
    cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
    ...overrides,
  }
}
const streams: StreamFactory = () => ({ close: () => {} })

let host: HTMLElement
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => {
  cleanup()
  host.remove()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const renderPanel = (client: ChatClient) =>
  render(<ChatPanel open embedded compact actionsHost={host} client={client} streamFactory={streams} />)
const header = () => within(host)
const openHistory = () => fireEvent.click(header().getByRole('button', { name: 'Show conversations' }))

describe('New chat', () => {
  it('creates a conversation, switches to it with an empty thread and a focused composer', async () => {
    localStorage.setItem('webterm.chatConversation', OLD.id)
    const client = makeClient()
    renderPanel(client)
    expect(await screen.findByText('hello from before')).not.toBeNull()

    fireEvent.click(header().getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(CREATED.id, expect.anything()))
    expect(client.createConversation).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('hello from before')).toBeNull())
    expect(document.activeElement).toBe(screen.getByLabelText('Message the central agent'))
    expect(localStorage.getItem('webterm.chatConversation')).toBe(CREATED.id)

    openHistory()
    const list = screen.getByRole('navigation', { name: 'Conversations' })
    expect(within(list).getAllByRole('button')[0]!.textContent).toContain('New chat')
  })

  it('disables the button while creating and shows a retryable error when creation fails', async () => {
    let reject: (e: unknown) => void = () => {}
    const client = makeClient({
      createConversation: vi.fn(() => new Promise<ChatConversation>((_, r) => { reject = r })),
    })
    renderPanel(client)
    await screen.findByLabelText('Message the central agent')
    const button = header().getByRole('button', { name: 'New chat' }) as HTMLButtonElement
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    await act(async () => reject(new ChatApiError('Ledger is off', 503, 'ledger_off')))
    expect(button.disabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('Could not start a new chat')
    // Still on the previous conversation.
    expect(localStorage.getItem('webterm.chatConversation')).toBe(OTHER.id)
  })
})

describe('History', () => {
  it('lists titles with relative time and switches conversation', async () => {
    const client = makeClient()
    renderPanel(client)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(OTHER.id, expect.anything()))
    openHistory()
    const list = screen.getByRole('navigation', { name: 'Conversations' })
    expect(within(list).getByRole('button', { name: /Release plan/ }).textContent).toContain('5m ago')
    fireEvent.click(within(list).getByRole('button', { name: /Old question/ }))
    expect(await screen.findByText('hello from before')).not.toBeNull()
    expect(localStorage.getItem('webterm.chatConversation')).toBe(OLD.id)
  })

  it('restores the persisted conversation, and falls back to the newest when it is gone', async () => {
    localStorage.setItem('webterm.chatConversation', OLD.id)
    const first = makeClient()
    renderPanel(first)
    await waitFor(() => expect(first.listMessages).toHaveBeenCalledWith(OLD.id, expect.anything()))
    cleanup()

    localStorage.setItem('webterm.chatConversation', 'central:chat:deleted')
    const second = makeClient()
    renderPanel(second)
    await waitFor(() => expect(second.listMessages).toHaveBeenCalledWith(OTHER.id, expect.anything()))
  })

  it('shows loading, then a list error with Retry', async () => {
    const listConversations = vi.fn()
      .mockRejectedValueOnce(new ChatApiError('Server error', 500, 'central_chat_internal'))
      .mockResolvedValue([OTHER])
    renderPanel(makeClient({ listConversations }))
    openHistory()
    expect(screen.getByText('Loading…')).not.toBeNull()
    expect((await screen.findByRole('alert')).textContent).toContain('The server could not answer')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: /Release plan/ })).not.toBeNull()
  })

  it('switching away from a running turn keeps it running (no cancel) and marks it live', async () => {
    const running = { ...OTHER, activeTurnId: 't1' }
    const client = makeClient({ listConversations: vi.fn(async () => [running, OLD]) })
    renderPanel(client)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(OTHER.id, expect.anything()))
    openHistory()
    expect(screen.getByLabelText('Turn running')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Old question/ }))
    expect(await screen.findByText('hello from before')).not.toBeNull()
    expect(client.cancelTurn).not.toHaveBeenCalled()
  })
})
