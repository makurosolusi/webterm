/** @vitest-environment jsdom */
// Root-locking tests for unread across Central conversations: the feed, badge, list marks, notice and label.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel'
import { ChatApiError } from './chatApi'
import { CHAT_POLL_MS, refresh } from './chat/chatFeed'
import { conversationLabel, type ChatClient, type ChatConversation } from './chat/chatTypes'
import type { StreamFactory } from './chat/chatConversation'

const make = (id: string, patch: Partial<ChatConversation>): ChatConversation => ({
  id, scope: 'global', projectId: null, activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 1, updatedAt: 10, title: null, ...patch,
})
const GLOBAL = make('central:global', {})
const PROJECT = make('central:project:p1', { projectId: 'p1', title: 'Billing app', updatedAt: 9 })

let rows: ChatConversation[]
let focused: boolean
const listConversations = vi.fn<ChatClient['listConversations']>()
const client: ChatClient = {
  listConversations,
  createConversation: vi.fn(async () => GLOBAL),
  listMessages: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({ messageId: 'm', seq: 1, turnId: 't', status: 'queued' as const })),
  cancelTurn: vi.fn(async () => ({ status: 'cancelled' as const })),
}
const streams: StreamFactory = () => ({ close: () => {} })

const mount = () => render(<ChatPanel open client={client} streamFactory={streams} />)
const poll = async () => { await act(async () => { refresh() }) }
const bump = (id: string, seq: number) => { rows = rows.map((row) => (row.id === id ? { ...row, lastMessageSeq: seq } : row)) }
const item = (name: RegExp) => screen.findByRole('button', { name })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('webterm.chatConversation', GLOBAL.id)
  rows = [GLOBAL, PROJECT]
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  listConversations.mockReset()
  listConversations.mockImplementation(async () => ({ items: rows.map((row) => ({ ...row })), nextOffset: null }))
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('unread per conversation', () => {
  it('a new message in an unwatched conversation is unread and badged; opening it clears; the watched one never is', async () => {
    mount()
    await item(/^Billing app/)
    expect(document.title).toBe('webterm')

    bump(PROJECT.id, 3)
    await poll()
    const unread = await item(/^Billing app, unread/) // (f) the item says so to assistive tech
    expect(document.title).toBe('(1) webterm')

    fireEvent.click(unread)
    await waitFor(() => expect(screen.queryByRole('button', { name: /unread/ })).toBeNull())
    expect(document.title).toBe('webterm')

    bump(PROJECT.id, 4) // watched now
    await poll()
    expect(screen.queryByRole('button', { name: /unread/ })).toBeNull()
    expect(document.title).toBe('webterm')
  })

  it('an unfocused window is not watching: the selected conversation turns unread too', async () => {
    mount()
    await item(/^Global/)
    focused = false
    bump(GLOBAL.id, 2)
    await poll()
    await item(/^Global, unread/)
    focused = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /unread/ })).toBeNull())
  })

  it('seenSeq survives a remount; a conversation never seen is not flagged on the first load', async () => {
    localStorage.setItem('webterm.chatSeenSeq', JSON.stringify({ [PROJECT.id]: 3 }))
    bump(PROJECT.id, 4)
    const first = mount()
    await item(/^Billing app, unread/)
    fireEvent.click(screen.getByRole('button', { name: /^Billing app/ }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('webterm.chatSeenSeq') ?? '{}')[PROJECT.id]).toBe(4))
    first.unmount()

    bump(PROJECT.id, 4)
    mount()
    await item(/^Billing app/)
    expect(screen.queryByRole('button', { name: /unread/ })).toBeNull()
  })

  it('the label is the server title, never the raw id, until the title is empty', async () => {
    expect(conversationLabel(PROJECT)).toBe('Billing app')
    expect(conversationLabel({ ...PROJECT, title: null })).toBe('p1')
    mount()
    await item(/^Billing app/)
    expect(screen.queryByText('p1')).toBeNull()
  })

  it('a reply in another conversation shows one notice in an always-mounted live region; opening it clears it', async () => {
    const { container } = mount()
    await item(/^Billing app/)
    const live = container.querySelector('.chat-live')!
    expect(live.getAttribute('role')).toBe('status')
    expect(live.getAttribute('aria-live')).toBe('polite')

    bump(PROJECT.id, 2)
    await poll()
    await waitFor(() => expect(live.textContent).toContain('Central replied in Billing app'))
    expect(container.querySelector('.chat-live')).toBe(live) // same node: it stayed mounted

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(live.textContent).toBe(''))
  })

  it('a remembered conversation that vanished is replaced with a one-time notice', async () => {
    localStorage.setItem('webterm.chatConversation', 'central:chat:gone')
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.chat-live')?.textContent).toContain('no longer available'))
  })
})

describe('live list', () => {
  it('polls every interval, stops while the tab is hidden and refreshes at once when it is visible again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const setHidden = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(listConversations).toHaveBeenCalledTimes(1)

    setHidden(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS * 3) })
    expect(listConversations).toHaveBeenCalledTimes(1) // the pending tick saw a hidden tab and stopped the loop

    setHidden(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(listConversations).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_POLL_MS) })
    expect(listConversations).toHaveBeenCalledTimes(3)
    setHidden(false)
  })

  it('a failed list shows the message with Retry (not silence); a later poll failure keeps the rows', async () => {
    listConversations.mockRejectedValueOnce(new ChatApiError('off', 503, 'central_runtime_off'))
    mount()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Central needs Claude')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await item(/^Billing app/)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    listConversations.mockRejectedValueOnce(new ChatApiError('off', 503, 'central_runtime_off'))
    await poll()
    expect((await screen.findByRole('alert')).textContent).toContain('Central needs Claude')
    expect(screen.getByRole('button', { name: /^Billing app/ })).not.toBeNull()
  })
})
