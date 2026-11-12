/** @vitest-environment jsdom */
// The Central chat layout: a status-only line above the thread (outside its scroll area), and the model
// picker, context meter and permission mode inside the composer box's control row, not in a header.
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import ChatConversationView, { type StreamFactory } from './chatConversation'
import type { ChatClient, ChatConversation } from './chatTypes'

vi.mock('../central/centralModel', async (orig) => ({
  ...(await orig<typeof import('../central/centralModel')>()),
  fetchCentralModel: vi.fn(async () => ({ alias: 'opus', effort: 'medium', tier: 'T3', pending: false, override: null })),
}))
vi.mock('../central/centralControlApi', async (orig) => ({
  ...(await orig<typeof import('../central/centralControlApi')>()),
  fetchCentralContext: vi.fn(async () => ({ tokens: 51_000, window: 100_000, percent: 51, lastCompaction: null })),
}))

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

/** The declarations of one CSS rule, by its exact selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

const conversation: ChatConversation = { // test-only
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 1, title: null,
}
function mount(commands = true) {
  const client: ChatClient = {
    listConversations: vi.fn(), createConversation: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(),
    listMessages: vi.fn(async () => []),
  }
  const factory: StreamFactory = () => ({ close: () => {} })
  const host = commands ? { centralEnabled: true, newChat: vi.fn(), showHistory: vi.fn() } : undefined
  const view = render(<TooltipProvider><ChatConversationView conversation={conversation} client={client} streamFactory={factory} commands={host} /></TooltipProvider>)
  return { client, ...view }
}

describe('Central chat layout', () => {
  it('renders the status line outside the scroll container, before it', async () => {
    const { container, client } = mount(false)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalled())
    const head = container.querySelector('.chat-conversation__head')!
    const thread = container.querySelector('.chat-thread')!
    expect(thread.contains(head)).toBe(false)
    expect(head.contains(thread)).toBe(false)
    expect(head.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('puts model, context meter and mode inside the composer box; the header has only the status', async () => {
    const { container } = mount()
    const box = container.querySelector('.chat-composer__box') as HTMLElement
    const row = within(box).getByRole('toolbar', { name: 'Composer controls' })
    expect(await within(row).findByRole('button', { name: 'Model: opus · medium · T3' })).toBeTruthy()
    expect(await within(row).findByRole('button', { name: /^Context 51%/ })).toBeTruthy()
    expect(within(row).getByRole('button', { name: /^Permission mode/ })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Send message' })).toBeTruthy()
    const head = container.querySelector('.chat-conversation__head') as HTMLElement
    expect(within(head).queryAllByRole('button')).toHaveLength(0) // no model, meter, mode or refresh up here
    expect(head.textContent).toBe('Ready')
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
  })

  it('keeps the status line a fixed opaque band and only the thread scrolling', () => {
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
