/** @vitest-environment jsdom */
// The Central chat status row sits above the thread, outside its scroll area, as an opaque band.
import { readFileSync } from 'node:fs'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatConversationView, { type StreamFactory } from './chatConversation'
import type { ChatClient, ChatConversation } from './chatTypes'

afterEach(cleanup)

/** The declarations of one CSS rule, by its exact selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('Central chat header', () => {
  it('renders the status row outside the scroll container, before it', async () => {
    const client: ChatClient = {
      listConversations: vi.fn(), createConversation: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(),
      listMessages: vi.fn(async () => []),
    }
    const conversation: ChatConversation = {
      id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
      lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 1, title: null,
    }
    const factory: StreamFactory = () => ({ close: () => {} })
    const { container } = render(<ChatConversationView conversation={conversation} client={client} streamFactory={factory} />)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalled())
    const head = container.querySelector('.chat-conversation__head')!
    const thread = container.querySelector('.chat-thread')!
    expect(head).toBeTruthy()
    expect(thread.contains(head)).toBe(false)
    expect(head.contains(thread)).toBe(false)
    expect(head.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the header a fixed opaque band and only the thread scrolling', () => {
    const css = readFileSync('src/client/chat/chat.css', 'utf8')
    const head = rule(css, '.chat-conversation__head')
    expect(head).toMatch(/flex:\s*none/)
    expect(head).toMatch(/background:\s*var\(/)
    expect(rule(css, '.chat-conversation')).toMatch(/overflow:\s*hidden/)
    const thread = rule(css, '.chat-thread')
    expect(thread).toMatch(/flex:\s*1/)
    expect(thread).toMatch(/min-height:\s*0/)
    expect(thread).toMatch(/overflow-y:\s*auto/)
  })
})
