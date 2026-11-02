/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel'
import { ChatApiError } from './chatApi'
import type {
  ChatClient, ChatConversation, ChatEvent, ChatStreamOptions,
} from './chat/chatTypes'
import type { StreamFactory } from './chat/chatConversation'

const GLOBAL: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 10,
}
const PROJECT: ChatConversation = {
  id: 'central:project:webterm', scope: 'project:webterm', projectId: 'webterm',
  activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 9,
}

function makeClient(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    listConversations: vi.fn(async () => [GLOBAL, PROJECT]),
    listMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ messageId: 'm1', seq: 1, turnId: 't1', status: 'queued' as const })),
    cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
    ...overrides,
  }
}

function makeStreams() {
  const opened: Array<{ id: string; opts: ChatStreamOptions; closed: boolean }> = []
  const factory: StreamFactory = (id, opts) => {
    const entry = { id, opts, closed: false }
    opened.push(entry)
    return { close: () => { entry.closed = true } }
  }
  return { factory, opened }
}

const flushFrame = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) =>
    setTimeout(callback, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

function renderPanel(client: ChatClient, streams = makeStreams()) {
  const utils = render(
    <ChatPanel open client={client} streamFactory={streams.factory} onClose={() => {}} />
  )
  return { ...utils, streams }
}

describe('ChatPanel list + empty states', () => {
  it('shows an empty state when the server lists no conversations', async () => {
    const client = makeClient({ listConversations: vi.fn(async () => []) })
    renderPanel(client)

    await waitFor(() => expect(screen.getAllByText('No conversations yet').length).toBeGreaterThan(0))
    expect(screen.queryByRole('log')).toBeNull()
  })

  it('renders global + project scopes and switches conversation on click', async () => {
    const client = makeClient()
    const streams = makeStreams()
    renderPanel(client, streams)

    expect(await screen.findByRole('button', { name: 'Global' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'webterm' }))

    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(
      'central:project:webterm', expect.anything()
    ))
    await waitFor(() => expect(streams.opened.some((entry) => entry.id === PROJECT.id)).toBe(true))
  })

  it('opens the SSE stream at the conversation cursor', async () => {
    const client = makeClient({ listConversations: vi.fn(async () => [{ ...GLOBAL, lastEventSeq: 42 }]) })
    const streams = makeStreams()
    renderPanel(client, streams)

    await waitFor(() => expect(streams.opened).toHaveLength(1))
    expect(streams.opened[0].opts.after).toBe(42)
  })
})

describe('ChatPanel send + stream', () => {
  it('sends on Enter with a clientMessageId and shows the optimistic text', async () => {
    const client = makeClient()
    renderPanel(client)

    const input = await screen.findByLabelText('Message the central agent')
    fireEvent.change(input, { target: { value: 'deploy main' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('deploy main')).not.toBeNull()
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    const [, payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(payload.text).toBe('deploy main')
    expect(typeof payload.clientMessageId).toBe('string')
    expect(payload.clientMessageId.length).toBeGreaterThan(0)
  })

  it('Shift+Enter inserts a newline instead of sending', async () => {
    const client = makeClient()
    renderPanel(client)

    const input = await screen.findByLabelText('Message the central agent')
    fireEvent.change(input, { target: { value: 'line one' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(client.sendMessage).not.toHaveBeenCalled()
    expect((input as HTMLTextAreaElement).value).toBe('line one')
  })

  it('renders streaming assistant text from part.delta frames', async () => {
    const client = makeClient()
    const streams = makeStreams()
    renderPanel(client, streams)
    await waitFor(() => expect(streams.opened).toHaveLength(1))

    const event: ChatEvent = {
      seq: 1, type: 'part.delta', conversationId: GLOBAL.id, messageId: 'a1',
      turnId: 't1', payload: { text: 'Hello from the agent' }, createdAt: 1,
    }
    streams.opened[0].opts.onEvent(event)
    await flushFrame()

    expect(await screen.findByText('Hello from the agent')).not.toBeNull()
  })

  it('shows a reconnect status while the stream retries', async () => {
    const client = makeClient()
    const streams = makeStreams()
    renderPanel(client, streams)
    await waitFor(() => expect(streams.opened).toHaveLength(1))

    streams.opened[0].opts.onStatus('reconnecting')
    expect(await screen.findByText('Reconnecting…')).not.toBeNull()
  })

  it('turns the primary button into Stop while a turn runs and cancels it', async () => {
    const client = makeClient()
    renderPanel(client)

    const input = await screen.findByLabelText('Message the central agent')
    fireEvent.change(input, { target: { value: 'start' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const stop = await screen.findByLabelText('Stop turn')
    fireEvent.click(stop)

    await waitFor(() => expect(client.cancelTurn).toHaveBeenCalledWith('t1'))
  })
})

describe('ChatPanel busy + errors', () => {
  it('shows conversation_busy and offers Stop for the active turn from another tab', async () => {
    const client = makeClient({
      sendMessage: vi.fn(async () => {
        throw new ChatApiError('busy', 409, 'conversation_busy', 't-other')
      }),
    })
    renderPanel(client)

    const input = await screen.findByLabelText('Message the central agent')
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect((await screen.findByRole('alert')).textContent).toContain('Another turn is running')
    fireEvent.click(await screen.findByLabelText('Stop turn'))
    await waitFor(() => expect(client.cancelTurn).toHaveBeenCalledWith('t-other'))
  })

  it('reports a failed conversation list', async () => {
    const client = makeClient({
      listConversations: vi.fn(async () => {
        throw new ChatApiError('off', 503, 'central_runtime_off')
      }),
    })
    renderPanel(client)

    expect((await screen.findByRole('alert')).textContent).toContain('runtime is off')
  })

  it('G-17: a failed list shows no Loading or empty copy beside the error, and Retry refetches', async () => {
    const listConversations = vi
      .fn<ChatClient['listConversations']>()
      .mockRejectedValueOnce(new ChatApiError('off', 503, 'central_runtime_off'))
      .mockResolvedValueOnce([GLOBAL])
    renderPanel(makeClient({ listConversations }))

    const alert = await screen.findByRole('alert')
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.queryByText(/No conversations yet/)).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(listConversations).toHaveBeenCalledTimes(2)
  })

  it('G-17: Loading is shown only while the first list request is pending', () => {
    renderPanel(makeClient({ listConversations: vi.fn(() => new Promise<ChatConversation[]>(() => {})) }))
    expect(screen.getByText('Loading…')).toBeDefined()
    expect(screen.queryByText(/No conversations yet/)).toBeNull()
  })
})
