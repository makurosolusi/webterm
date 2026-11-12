/** @vitest-environment jsdom */
// Your own messages render as a right-aligned bubble (no "You" header) in both chats; replies have no
// per-message header (Copy and the model meta sit in a hover/focus row); a system message is one compact
// line; a failed Central reply shows its reason and a Retry that resends.
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatMessages from './chatMessages'
import type { ChatClient, ChatMessage } from './chatTypes'
import { normalizeParts } from './chatWire'
import ChatPanel from '../ChatPanel'
import { initialAgentChatState, type ChatMessageView } from '../agentChat/agentChatStore'
import { AgentChatThread, type ThreadActions } from '../agentChat/agentChatThread'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const human = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'human', seq: 1, state: 'complete', parts: [{ type: 'text', text }], ...over })
const reply = (id: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'assistant', seq: 2, state: 'complete', parts: [{ type: 'text', text: 'Sure.' }], ...over })

/** The bubble structure both chats share. */
function expectBubble(row: HTMLElement, text: string): void {
  expect(row.classList.contains('chat-bubble-row')).toBe(true)
  const bubble = row.querySelector('.chat-bubble') as HTMLElement
  expect(bubble.textContent).toContain(text)
  expect(row.querySelector('.chat-message__meta')).toBeNull()
  expect(bubble.querySelector('.sr-only')?.textContent).toBe('You said: ')
}

describe('Central chat bubbles', () => {
  it('your message is a bubble without a visible "You" header; the reply has no header either', () => {
    render(<ChatMessages messages={[human('h1', 'line one\nline two'), reply('a1')]} streaming={false} />)
    const row = screen.getByLabelText('human message')
    expectBubble(row, 'line one\nline two')
    expect(row.querySelector('.chat-text--plain')?.textContent).toBe('line one\nline two')
    expect(screen.queryByText('You')).toBeNull()

    const agent = screen.getByLabelText('assistant message')
    expect(agent.classList.contains('chat-bubble-row')).toBe(false)
    expect(agent.querySelector('.chat-message__meta')).toBeNull()
    expect(within(agent).queryByText('Central agent')).toBeNull()
    expect(agent.querySelector('.codicon-sparkle')).toBeNull()
  })

  it('model and tier of a reply are in its hover/focus action row, the cost only in the tooltip', () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 7_660_000, model: 'claude-opus-5-5', tier: 'T3' }
    render(<ChatMessages messages={[human('h1', 'hi'), reply('a1', { usage, turnId: 't1' })]} streaming={false} />)
    const agent = screen.getByLabelText('assistant message')
    const row = within(agent).getByRole('toolbar', { name: 'Message actions' })
    expect(row.className).toBe('act-row')
    const meta = within(row).getByText('opus · T3')
    expect(meta.getAttribute('title')).toContain('$7.66')
    expect(within(row).getByRole('button', { name: /^Show what Central used in this turn: Memories used/ })).toBeTruthy()
    expect(agent.textContent).not.toContain('$7.66')
    // Hidden until the message is hovered or holds keyboard focus.
    const css = readFileSync('src/client/chat/chatMessageActions.css', 'utf8')
    expect(css).toMatch(/\.act-row \{[^}]*opacity: 0;/)
    expect(css).toMatch(/\.chat-message:hover \.act-row,\s*\.chat-message:focus-within \.act-row/)
  })

  it('a system message is one compact centered line with its time on hover, no "System" header', () => {
    const sys: ChatMessage = { id: 's1', role: 'system', seq: 3, state: 'complete', parts: [{ type: 'text', text: 'Model set to opus.' }], createdAt: 1_700_000_000_000 }
    render(<ChatMessages messages={[human('h1', 'hi'), sys]} streaming={false} />)
    const line = screen.getByText('Model set to opus.').closest('.chat-notice') as HTMLElement
    expect(line.className).toBe('chat-notice chat-notice--info')
    expect(line.getAttribute('title')).toBe(new Date(1_700_000_000_000).toLocaleString())
    expect(screen.queryByText('System')).toBeNull()
    expect(screen.queryByLabelText('system message')).toBeNull()
  })

  it('Copy copies a reply and your message', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<ChatMessages messages={[human('h1', 'my question'), reply('a1')]} streaming={false} />)
    await act(async () => { fireEvent.click(within(screen.getByLabelText('assistant message')).getByRole('button', { name: 'Copy message' })) })
    expect(writeText).toHaveBeenLastCalledWith('Sure.')
    expect(await screen.findByText('Copied')).toBeTruthy()
    await act(async () => { fireEvent.click(within(screen.getByLabelText('human message')).getByRole('button', { name: 'Copy message' })) })
    expect(writeText).toHaveBeenLastCalledWith('my question')
  })

  it('no Copy row while the reply streams', () => {
    render(<ChatMessages messages={[human('h1', 'hi'), reply('a1', { state: 'streaming' })]} streaming />)
    expect(within(screen.getByLabelText('assistant message')).queryByRole('toolbar')).toBeNull()
  })

  it('a runtime notice renders as a note on the reply, persisted parts included', () => {
    const note = 'Started a fresh Claude session; the previous one was no longer available.'
    const parts = normalizeParts([{ type: 'notice', text: note }, { type: 'text', text: 'hi' }])
    render(<ChatMessages messages={[human('h1', 'hello'), reply('a1', { parts })]} streaming={false} />)
    const agent = screen.getByLabelText('assistant message')
    const shown = within(agent).getByRole('note')
    expect(shown.textContent).toBe(note)
    expect(shown.className).toBe('chat-notice-inline')
  })

  it('a failed reply shows its reason (long text clipped) and Retry resends the message that started it', () => {
    const onRetry = vi.fn()
    const long = 'x'.repeat(600)
    const failed = reply('a1', { state: 'failed', parts: [{ type: 'text', text: 'Part' }, { type: 'error', code: 'timeout', message: long }] })
    render(<ChatMessages messages={[human('h1', 'deploy main'), failed]} streaming={false} onRetry={onRetry} />)
    const agent = screen.getByLabelText('assistant message')
    expect(agent.getAttribute('data-state')).toBe('failed')
    expect(within(agent).getByRole('note').textContent).toBe(`${'x'.repeat(500)}…`)
    fireEvent.click(within(agent).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('deploy main', [])
    cleanup()
    render(<ChatMessages messages={[human('h1', 'deploy main'), failed, human('h2', 'next', { seq: 3 })]} streaming={false} onRetry={onRetry} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull() // an older failure is not retried
  })

  it('a turn blocked by the Claude check shows the probe sentence and opens Settings › Claude › Connection test', () => {
    const opened = vi.fn()
    window.addEventListener('webterm:open-settings', opened as EventListener)
    const message = 'Claude Code is not ready for launch profile "envman": envman not found on PATH. Install it on the server, or fix the command in the launch profile.'
    const failed = reply('a1', { state: 'failed', parts: [{ type: 'error', code: 'runtime_unavailable', message }] })
    render(<ChatMessages messages={[human('h1', 'hi'), failed]} streaming={false} />)
    const note = within(screen.getByLabelText('assistant message')).getByRole('note')
    expect(note.textContent).toContain(message)
    fireEvent.click(within(note).getByRole('button', { name: 'Open Settings › Claude › Connection test' }))
    window.removeEventListener('webterm:open-settings', opened as EventListener)
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'claude', field: 'claude-provider' })
  })

  it('a failed reply without a stored reason says so instead of a bare "failed"', () => {
    render(<ChatMessages messages={[human('h1', 'hi'), reply('a1', { state: 'failed', parts: [] })]} streaming={false} />)
    expect(screen.getByText('The reply failed before it finished.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull() // no resend path given
  })

  it('an unsent message offers Retry with its own text; no Retry while a turn runs', () => {
    const onRetry = vi.fn()
    const unsent = human('h1', 'again', { state: 'failed', seq: null, optimistic: true })
    const { rerender } = render(<ChatMessages messages={[unsent]} streaming={false} onRetry={onRetry} />)
    expect(screen.getByText('Not sent')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('again', [])
    rerender(<ChatMessages messages={[unsent]} streaming onRetry={onRetry} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('Central chat Retry through the panel', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  it('resends the failed text as a new message', async () => {
    const failed = reply('a1', { state: 'failed', parts: [{ type: 'error', code: 'runtime_error', message: 'claude timed out' }] })
    const conversation = { id: 'central:global', scope: 'global', projectId: null, activeTurnId: null, lastEventSeq: 3, lastMessageSeq: 2, updatedAt: 1, title: null }
    const client: ChatClient = {
      listConversations: vi.fn(async () => ({ items: [conversation], nextOffset: null })),
      createConversation: vi.fn(async () => conversation),
      listMessages: vi.fn(async () => [human('h1', 'summarize the board'), failed]),
      sendMessage: vi.fn(async () => ({ messageId: 'h2', seq: 3, turnId: 't2', status: 'queued' as const })),
      cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
    }
    render(<ChatPanel open client={client} streamFactory={() => ({ close: () => {} })} onClose={() => {}} />)
    expect(await screen.findByText('claude timed out')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1))
    const [, payload] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(payload.text).toBe('summarize the board')
  })
})

describe('Agent Chat bubbles', () => {
  const actions: ThreadActions = { answer: vi.fn(), setMode: vi.fn(), loadFull: vi.fn(), imageUrl: (r) => `/img/${r}` }
  const msg = (id: string, role: 'user' | 'assistant', parts: ChatMessageView['parts']): ChatMessageView =>
    ({ id, role, parts, draft: [] })

  it('your message (text + image) is a bubble with its actions; the reply has no "Claude" header', () => {
    const state = {
      ...initialAgentChatState('n1'),
      order: ['m:u', 'm:a'],
      messages: {
        u: msg('u', 'user', [{ k: 'image', mediaType: 'image/png', ref: 'r1' }, { k: 'text', text: 'what is this?' }]),
        a: msg('a', 'assistant', [{ k: 'text', text: 'A cat.' }]),
      },
    }
    render(<AgentChatThread state={state} actions={{ ...actions, branch: { edit: vi.fn(), rewind: vi.fn() } }} />)
    const row = screen.getByLabelText('user message')
    expectBubble(row, 'what is this?')
    expect(row.querySelector('.chat-bubble img')?.getAttribute('src')).toBe('/img/r1')
    expect(within(row).getByRole('toolbar', { name: 'Message actions' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Edit message' })).toBeTruthy()
    expect(screen.queryByText('You')).toBeNull()

    const agent = screen.getByLabelText('assistant message')
    expect(agent.classList.contains('chat-bubble-row')).toBe(false)
    expect(within(agent).queryByText('Claude')).toBeNull()
    expect(agent.querySelector('.chat-message__meta')).toBeNull()
  })

  it('Copy copies a Claude reply', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const state = { ...initialAgentChatState('n1'), order: ['m:a'], messages: { a: msg('a', 'assistant', [{ k: 'text', text: 'A cat.' }]) } }
    render(<AgentChatThread state={state} actions={actions} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy message' })) })
    expect(writeText).toHaveBeenCalledWith('A cat.')
  })
})
