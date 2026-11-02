/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InboxChatPanel from './inboxChatPanel'
import type { InboxClient, InboxItem } from './inboxApi'
import type { ChatClient, ChatConversation, ChatStreamOptions } from './chat/chatTypes'
import type { StreamFactory } from './chat/chatConversation'

const ITEMS: InboxItem[] = [
  { id: 'i1', kind: 'deploy', state: 'needs_you', projectId: 'proj-a', title: 'Deploy main', ageMs: 60_000 },
]

const GLOBAL: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 10,
}

function makeInboxClient(): InboxClient {
  return {
    listInbox: vi.fn(async () => ITEMS),
    getApprovalChallenge: vi.fn(),
    requestApproval: vi.fn(),
    decideApproval: vi.fn(),
    consumeApproval: vi.fn(),
  } as unknown as InboxClient
}

function makeChatClient(): ChatClient {
  return {
    listConversations: vi.fn(async () => [GLOBAL]),
    listMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ messageId: 'm1', seq: 1, turnId: 't1', status: 'queued' as const })),
    cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
  }
}

function makeStreams() {
  const opened: Array<{ id: string; opts: ChatStreamOptions }> = []
  const factory: StreamFactory = (id, opts) => {
    opened.push({ id, opts })
    return { close: () => undefined }
  }
  return { factory, opened }
}

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

describe('InboxChatPanel tabs', () => {
  it('renders one VS Code tab per pane and starts on Inbox', async () => {
    const inbox = makeInboxClient()
    const streams = makeStreams()
    render(
      <InboxChatPanel
        inboxOpen chatOpen
        inbox={{ client: inbox }}
        chat={{ client: makeChatClient(), streamFactory: streams.factory }}
      />
    )

    expect(await screen.findByRole('tab', { name: /^Inbox/ })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /^Chat/ })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /^Inbox/ }).getAttribute('aria-selected')).toBe('true')
    // The panel now uses the bottom-panel tab strip (35px title row), not the editor tab strip.
    expect(document.querySelector('.vscode-panel-tabs')).not.toBeNull()
    expect(document.querySelector('.vscode-editor-tabs')).toBeNull()
    expect(screen.getByLabelText('Refresh inbox')).not.toBeNull()
    expect(screen.getByLabelText('Refresh conversations')).not.toBeNull()
    expect(await screen.findByText('Deploy main')).not.toBeNull()
  })

  it('keeps both panes mounted: switching tabs does not refetch inbox or reopen the stream', async () => {
    const inbox = makeInboxClient()
    const streams = makeStreams()
    render(
      <InboxChatPanel
        inboxOpen chatOpen
        inbox={{ client: inbox }}
        chat={{ client: makeChatClient(), streamFactory: streams.factory }}
      />
    )
    await waitFor(() => expect(streams.opened).toHaveLength(1))
    expect(inbox.listInbox).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('tab', { name: /^Chat/ }))
    expect(screen.getByRole('tab', { name: /^Chat/ }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByLabelText('Message the central agent')).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /^Inbox/ }))
    expect(screen.getByRole('tab', { name: /^Inbox/ }).getAttribute('aria-selected')).toBe('true')
    expect(inbox.listInbox).toHaveBeenCalledTimes(1)
    expect(streams.opened).toHaveLength(1)
  })

  it('closes one pane from its tab and hands the panel to the other pane', async () => {
    const onCloseInbox = vi.fn()
    render(
      <InboxChatPanel
        inboxOpen chatOpen onCloseInbox={onCloseInbox}
        inbox={{ client: makeInboxClient() }}
        chat={{ client: makeChatClient(), streamFactory: makeStreams().factory }}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Close Inbox' }))
    expect(onCloseInbox).toHaveBeenCalledTimes(1)
  })

  it('renders a single tab when only one pane is open', () => {
    render(
      <InboxChatPanel
        inboxOpen={false} chatOpen
        chat={{ client: makeChatClient(), streamFactory: makeStreams().factory }}
      />
    )
    expect(screen.queryByRole('tab', { name: /^Inbox/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /^Chat/ })).not.toBeNull()
  })
})
