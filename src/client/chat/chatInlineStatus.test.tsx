/** @vitest-environment jsdom */
// Root lock for the turn status: it lives at the END of the thread (never in a header), the screen reader hears
// one sentence per phase (never per token), the reader's scroll position is kept, and a failure is one sticky
// surface above the composer. A test here fails if someone moves the status back up or makes it chatty.
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import ChatConversationView, { type StreamFactory } from './chatConversation'
import ChatMessages from './chatMessages'
import type { ChatClient, ChatConversation, ChatEvent, ChatMessage, ChatStreamOptions } from './chatTypes'

const conversation: ChatConversation = { // test-only
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 1, title: null,
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

let opts: ChatStreamOptions
let seq = 0
const flushAll = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(40) }) }
async function emit(type: string, extra: Partial<ChatEvent> = {}): Promise<void> {
  seq += 1
  opts.onEvent({ seq, type, conversationId: conversation.id, turnId: 't1', messageId: 'a1', createdAt: 1, ...extra })
  await flushAll()
}

async function mount(listMessages: ChatClient['listMessages'] = async () => []) {
  seq = 0
  const client: ChatClient = {
    listConversations: vi.fn(), createConversation: vi.fn(), sendMessage: vi.fn(), cancelTurn: vi.fn(), listMessages,
  }
  const factory: StreamFactory = (_id, o) => { opts = o; return { close: () => {} } }
  const view = render(<TooltipProvider><ChatConversationView conversation={conversation} client={client} streamFactory={factory} /></TooltipProvider>)
  await flushAll()
  return { ...view, client }
}
const startTurn = (): Promise<void> => emit('turn.status', { payload: { status: 'running' } })
const live = (): HTMLElement => screen.getByTestId('turn-live-region')
const row = (c: HTMLElement): HTMLElement => c.querySelector('.chat-inline-status') as HTMLElement

describe('inline turn status', () => {
  it('(a) shows the right row per phase and nothing when idle', async () => {
    const { container } = await mount()
    expect(row(container).textContent).toBe('')
    await startTurn()
    expect(row(container).textContent).toBe('Thinking…')
    await emit('part.delta', { payload: { text: 'Hel' } })
    expect(row(container).textContent).toBe('Responding…')
    await emit('tool.requested', { payload: { toolCallId: 'c1', name: 'node.list' } })
    expect(row(container).textContent).toBe('Running: List nodes…')
    await emit('tool.completed', { payload: { toolCallId: 'c1', name: 'node.list', ok: true } })
    expect(row(container).textContent).toBe('Responding…')
    await emit('turn.status', { payload: { status: 'succeeded' } })
    await emit('done')
    expect(row(container).textContent).toBe('')
  })

  it('(a, g) shows Reconnecting inline at the end of the thread, not anywhere else', async () => {
    const { container } = await mount()
    await act(async () => { opts.onStatus?.('reconnecting') })
    const slot = row(container)
    expect(slot.textContent).toBe('Reconnecting…')
    expect(slot.closest('.chat-thread')).not.toBeNull()
    expect(slot.parentElement!.lastElementChild).toBe(slot)
    expect(container.querySelector('header')).toBeNull()
    await act(async () => { opts.onStatus?.('open') })
    expect(row(container).textContent).toBe('')
  })

  it('(b) POLICY: the conversation has no header and no spinner or status dot outside the thread', async () => {
    const { container } = await mount()
    await startTurn()
    expect(container.querySelector('header, .chat-conversation__head, .chat-conversation__status')).toBeNull()
    for (const el of container.querySelectorAll('.chat-progress, .chat-status-dot')) expect(el.closest('.chat-thread')).not.toBeNull()
    const section = container.querySelector('.chat-conversation')!
    expect(within(section as HTMLElement).queryByText('Streaming')).toBeNull()
    const source = readFileSync('src/client/chat/chatConversation.tsx', 'utf8')
    expect(source).not.toMatch(/<header|chat-progress|chat-status-dot|chat-conversation__status/)
    expect(readFileSync('src/client/chat/chat.css', 'utf8')).not.toContain('.chat-conversation__head')
  })

  it('(c) live region: always mounted, polite, sr-only, one sentence per phase, no token text', async () => {
    await mount()
    const region = live()
    expect(region.classList.contains('sr-only')).toBe(true)
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-live')).not.toBe('assertive')
    expect(region.textContent).toBe('')
    const said: string[] = []
    const watch = (): void => { if (region.textContent && said.at(-1) !== region.textContent) said.push(region.textContent) }
    await startTurn(); watch()
    for (let i = 0; i < 40; i += 1) { await emit('part.delta', { payload: { text: `token${i} ` } }); watch() }
    expect(region.textContent).not.toMatch(/token/)
    await emit('tool.requested', { payload: { toolCallId: 'c1', name: 'node.list' } }); watch()
    await emit('turn.status', { payload: { status: 'succeeded' } }); watch()
    await emit('done'); watch()
    expect(said).toEqual(['Responding…', 'Response complete.'])
    expect(said.length).toBeLessThanOrEqual(2)
  })

  it('(c) aria-busy is on only while a turn runs', async () => {
    await mount()
    const log = screen.getByRole('log')
    expect(log.getAttribute('aria-busy')).toBe('false')
    await startTurn()
    expect(log.getAttribute('aria-busy')).toBe('true')
    await emit('turn.status', { payload: { status: 'succeeded' } })
    expect(log.getAttribute('aria-busy')).toBe('false')
  })

  it('(h) the row is one fixed-size element that stays mounted in every phase (no layout shift)', async () => {
    const { container } = await mount()
    const slot = row(container)
    await startTurn()
    expect(row(container)).toBe(slot)
    await emit('part.delta', { payload: { text: 'x' } })
    expect(row(container)).toBe(slot)
    await act(async () => { opts.onStatus?.('reconnecting') })
    expect(row(container)).toBe(slot)
    const css = readFileSync('src/client/chat/chatInlineStatus.css', 'utf8')
    expect(/\n\.chat-inline-status\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(/\bheight:\s*20px/)
  })

  it('(e) reduced motion: the dots animate only inside a no-preference block, with token colors', () => {
    const css = readFileSync('src/client/chat/chatInlineStatus.css', 'utf8')
    const open = css.indexOf('@media (prefers-reduced-motion: no-preference)')
    expect(open).toBeGreaterThan(-1)
    const before = css.slice(0, open)
    expect(before).not.toMatch(/animation\s*:/)
    expect(css.slice(open)).toMatch(/animation:\s*chat-inline-dot/)
    expect(before).toMatch(/var\(--vscode-/)
  })
})

describe('error surface', () => {
  it('(f) a failure is one sticky alert between the thread and the composer, with Retry and Dismiss', async () => {
    let calls = 0
    const { container } = await mount(async () => { calls += 1; if (calls === 1) throw new Error('history down'); return [] })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Something went wrong. Try again.')
    const section = container.querySelector('.chat-conversation')!
    const thread = container.querySelector('.chat-thread-wrap')!
    const composer = container.querySelector('.chat-composer')!
    expect(thread.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.parentElement).toBe(section)
    expect(live().textContent).toBe('Something went wrong.')
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })) })
    await flushAll()
    expect(calls).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('(f) Dismiss clears it', async () => {
    await mount(async () => { throw new Error('boom') })
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss error' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('scroll behaviour', () => {
  const msg = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', seq: 1, state: 'complete', parts: [{ type: 'text', text }] }) // test-only
  /** A scroll area with a settable scrollTop (jsdom ignores writes). */
  function fakeScroll(el: HTMLElement): { top: () => number } {
    let top = 0
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 })
    return { top: () => top }
  }

  it('(d) follows new content at the bottom; keeps the place when scrolled up and offers a pill', () => {
    const { rerender, container } = render(<ChatMessages messages={[msg('1', 'a')]} streaming />)
    const thread = container.querySelector('.chat-thread') as HTMLElement
    const scroll = fakeScroll(thread)
    rerender(<ChatMessages messages={[msg('1', 'a'), msg('2', 'b')]} streaming />)
    expect(scroll.top()).toBe(1000) // was at the bottom: followed
    expect(screen.queryByRole('button', { name: /Jump to latest|New messages/ })).toBeNull()

    act(() => { thread.scrollTop = 0; fireEvent.scroll(thread) })
    rerender(<ChatMessages messages={[msg('1', 'a'), msg('2', 'b'), msg('3', 'c')]} streaming />)
    expect(scroll.top()).toBe(0) // reader's place kept
    const pill = screen.getByRole('button', { name: 'New messages' })
    fireEvent.click(pill)
    expect(scroll.top()).toBe(1000)
    expect(screen.queryByRole('button', { name: /Jump to latest|New messages/ })).toBeNull()
  })

  it('(d) the pill reads "Jump to latest" before anything new arrived', () => {
    const { container } = render(<ChatMessages messages={[msg('1', 'a')]} streaming={false} />)
    const thread = container.querySelector('.chat-thread') as HTMLElement
    fakeScroll(thread)
    act(() => { thread.scrollTop = 0; fireEvent.scroll(thread) })
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
  })
})
