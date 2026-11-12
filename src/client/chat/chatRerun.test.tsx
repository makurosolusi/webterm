/** @vitest-environment jsdom */
// Regenerate and Edit of the Central chat's last exchange: offered only on the last human message and its
// settled reply while idle; Regenerate and Edit's Save & Send call the API; Cancel restores the bubble; the
// stream's `message.superseded` frame drops the old rows.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import ChatConversationView, { type StreamFactory } from './chatConversation'
import ChatMessages from './chatMessages'
import { chatReducer, initialChatState } from './chatStore'
import type { ChatClient, ChatConversation, ChatMessage } from './chatTypes'

vi.mock('../central/centralModel', async (orig) => ({
  ...(await orig<typeof import('../central/centralModel')>()),
  fetchCentralModel: vi.fn(async () => ({ alias: 'opus', effort: 'medium', tier: 'T3', pending: false, override: null })),
}))
vi.mock('../central/centralControlApi', async (orig) => ({
  ...(await orig<typeof import('../central/centralControlApi')>()),
  fetchCentralContext: vi.fn(async () => ({ tokens: 1, window: 100, percent: 1, lastCompaction: null })),
}))

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

// test-only rows
const msg = (id: string, role: 'human' | 'assistant', seq: number, turnId: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, seq, turnId, state: 'complete', parts: [{ type: 'text', text }], ...over })
const thread = (): ChatMessage[] => [
  msg('h1', 'human', 1, 't1', 'first question'), msg('a1', 'assistant', 2, 't1', 'first answer'),
  msg('h2', 'human', 3, 't2', 'second question'), msg('a2', 'assistant', 4, 't2', 'second answer'),
]
const conversation: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 4, updatedAt: 1, title: null,
}
const started = { messageId: 'h3', seq: 5, turnId: 't3', status: 'running' as const }

function mount(messages = thread()) {
  const client: ChatClient = {
    listConversations: vi.fn(), createConversation: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(),
    listMessages: vi.fn(async () => messages),
    regenerate: vi.fn(async () => started), editMessage: vi.fn(async () => started),
  }
  const factory: StreamFactory = () => ({ close: () => {} })
  render(<TooltipProvider><ChatConversationView conversation={conversation} client={client} streamFactory={factory} /></TooltipProvider>)
  return client
}

const row = (text: string): HTMLElement => screen.getByText(text).closest('.chat-message') as HTMLElement

describe('Regenerate / Edit availability', () => {
  it('only the last human message has Edit and only its reply has Regenerate', async () => {
    mount()
    await screen.findByText('second answer')
    expect(within(row('second answer')).getByRole('button', { name: 'Regenerate reply' })).toBeTruthy()
    expect(within(row('second question')).getByRole('button', { name: 'Edit message' })).toBeTruthy()
    expect(within(row('first answer')).queryByRole('button', { name: 'Regenerate reply' })).toBeNull()
    expect(within(row('first question')).queryByRole('button', { name: 'Edit message' })).toBeNull()
    expect(within(row('second question')).queryByRole('button', { name: 'Regenerate reply' })).toBeNull()
  })

  it('neither shows while a turn runs, nor without the API, nor Regenerate on a failed reply (Retry covers it)', () => {
    const handlers = { onRegenerate: vi.fn(), onEdit: vi.fn() }
    const { rerender } = render(<ChatMessages messages={thread()} streaming {...handlers} />)
    expect(screen.queryByRole('button', { name: 'Regenerate reply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
    rerender(<ChatMessages messages={thread()} streaming={false} />)
    expect(screen.queryByRole('button', { name: 'Regenerate reply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
    const failed = [...thread().slice(0, 3), msg('a2', 'assistant', 4, 't2', 'half', { state: 'failed' })]
    rerender(<ChatMessages messages={failed} streaming={false} {...handlers} />)
    expect(screen.queryByRole('button', { name: 'Regenerate reply' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeTruthy()
  })
})

describe('Regenerate / Edit actions', () => {
  it('Regenerate calls the API with the reply', async () => {
    const client = mount()
    await screen.findByText('second answer')
    fireEvent.click(within(row('second answer')).getByRole('button', { name: 'Regenerate reply' }))
    await waitFor(() => expect(client.regenerate).toHaveBeenCalledTimes(1))
    expect(vi.mocked(client.regenerate!).mock.calls[0]![0]).toBe('central:global')
    expect(vi.mocked(client.regenerate!).mock.calls[0]![1]).toMatchObject({ messageId: 'a2' })
  })

  it('Edit opens an inline editor; Save & Send sends the new text', async () => {
    const client = mount()
    await screen.findByText('second question')
    fireEvent.click(within(row('second question')).getByRole('button', { name: 'Edit message' }))
    const box = screen.getByRole('textbox', { name: 'Message text' }) as HTMLTextAreaElement
    expect(box.value).toBe('second question')
    fireEvent.change(box, { target: { value: 'better question' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    await waitFor(() => expect(client.editMessage).toHaveBeenCalledTimes(1))
    expect(vi.mocked(client.editMessage!).mock.calls[0]![1]).toMatchObject({ messageId: 'h2', text: 'better question' })
    expect(screen.queryByRole('textbox', { name: 'Message text' })).toBeNull()
  })

  it('Cancel restores the message and sends nothing; an empty edit cannot be saved', async () => {
    const client = mount()
    await screen.findByText('second question')
    fireEvent.click(within(row('second question')).getByRole('button', { name: 'Edit message' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message text' }), { target: { value: '  ' } })
    expect((screen.getByRole('button', { name: 'Save & Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox', { name: 'Message text' })).toBeNull()
    expect(screen.getByText('second question')).toBeTruthy()
    expect(client.editMessage).not.toHaveBeenCalled()
  })

  it('a refused re-run shows the reason', async () => {
    const client = mount()
    const { ChatApiError } = await import('./chatTransport')
    vi.mocked(client.regenerate!).mockRejectedValueOnce(new ChatApiError('x', 400, 'not_last_message'))
    await screen.findByText('second answer')
    fireEvent.click(within(row('second answer')).getByRole('button', { name: 'Regenerate reply' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Only your last message can be regenerated or edited.')
  })
})

describe('message.superseded frame', () => {
  it('drops the superseded rows from the thread', () => {
    const state = chatReducer(initialChatState('central:global'), { type: 'hydrate', messages: thread() })
    const next = chatReducer(state, { type: 'event', event: {
      seq: 9, type: 'message.superseded', conversationId: 'central:global', payload: { messageIds: ['h2', 'a2'], reason: 'edit' }, createdAt: 1,
    } })
    expect(next.messages.map((m) => m.id)).toEqual(['h1', 'a1'])
  })
})
