/** @vitest-environment jsdom */
// The Central chat layout: no status header at all (the status is inline, see chatInlineStatus.test), and the
// model picker, context meter and permission mode inside the composer box's control row.
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
  it('has no header: the turn status is not a band above the thread', async () => {
    const { container, client } = mount(false)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalled())
    expect(container.querySelector('.chat-conversation__head')).toBeNull()
    expect(container.querySelector('header')).toBeNull()
  })

  it('puts model, context meter and mode inside the composer box', async () => {
    const { container } = mount()
    const box = container.querySelector('.chat-composer__box') as HTMLElement
    const row = within(box).getByRole('toolbar', { name: 'Composer controls' })
    expect(await within(row).findByRole('button', { name: 'Model: opus · medium · T3' })).toBeTruthy()
    expect(await within(row).findByRole('button', { name: /^Context 51%/ })).toBeTruthy()
    expect(within(row).getByRole('button', { name: /^Permission mode/ })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Send message' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
  })

  it('keeps only the thread scrolling', () => {
    const css = readFileSync('src/client/chat/chat.css', 'utf8')
    expect(css).not.toContain('.chat-conversation__head')
    expect(rule(css, '.chat-conversation')).toMatch(/overflow:\s*hidden/)
    const thread = rule(css, '.chat-thread')
    expect(thread).toMatch(/flex:\s*1/)
    expect(thread).toMatch(/min-height:\s*0/)
    expect(thread).toMatch(/overflow-y:\s*auto/)
  })
})
