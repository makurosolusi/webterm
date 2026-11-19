/** @vitest-environment jsdom */
// Which conversation the Central chat panel lands on: the steward chat, never a skill-author chat by accident.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel'
import { requestOpenConversation } from './chat/chatFeed'
import type { StreamFactory } from './chat/chatConversation'
import type { ChatClient, ChatConversation } from './chat/chatTypes'

const row = (id: string, updatedAt: number, extra: Partial<ChatConversation> = {}): ChatConversation =>
  ({ id, scope: id, projectId: null, activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 0, updatedAt, title: null, ...extra })
const STEWARD_OLD = row('central:chat:steward', 5, { title: 'Release plan' })
const AUTHOR_NEW = row('central:chat:author', 9, { mode: 'skill-author', skillTarget: 'webterm-rule' })
const CREATED = row('central:chat:new', 20)
const streams: StreamFactory = () => ({ close: () => {} })

function makeClient(items: ChatConversation[]): ChatClient {
  return {
    listConversations: vi.fn(async () => ({ items, nextOffset: null })),
    createConversation: vi.fn(async () => CREATED),
    listMessages: vi.fn(async () => []),
    sendMessage: vi.fn(), cancelTurn: vi.fn(),
  }
}
const mount = (client: ChatClient, host: HTMLElement) =>
  render(<ChatPanel open embedded compact actionsHost={host} centralEnabled client={client} streamFactory={streams} />)

let host: HTMLElement
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => { cleanup(); host.remove(); vi.unstubAllGlobals(); localStorage.clear() })

describe('Central chat selection', () => {
  it('falls back to the older steward chat, not the newer skill-author chat', async () => {
    const client = makeClient([AUTHOR_NEW, STEWARD_OLD])
    mount(client, host)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(STEWARD_OLD.id, expect.anything()))
    expect(client.listMessages).not.toHaveBeenCalledWith(AUTHOR_NEW.id, expect.anything())
    expect(screen.queryByRole('complementary', { name: 'Skill author' })).toBeNull()
  })

  it('does not restore a remembered skill-author selection', async () => {
    localStorage.setItem('webterm.chatConversation', AUTHOR_NEW.id)
    const client = makeClient([AUTHOR_NEW, STEWARD_OLD])
    mount(client, host)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(STEWARD_OLD.id, expect.anything()))
    expect(screen.queryByRole('complementary', { name: 'Skill author' })).toBeNull()
    expect(localStorage.getItem('webterm.chatConversation')).toBe(STEWARD_OLD.id)
  })

  it('still restores a remembered steward selection', async () => {
    const other = row('central:chat:other', 30, { title: 'Newer' })
    localStorage.setItem('webterm.chatConversation', STEWARD_OLD.id)
    const client = makeClient([other, STEWARD_OLD])
    mount(client, host)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(STEWARD_OLD.id, expect.anything()))
  })

  it('shows an empty state, not the author chat, when only skill-author chats exist', async () => {
    const client = makeClient([AUTHOR_NEW])
    mount(client, host)
    expect(await screen.findByText(/No Central chat yet/)).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Skill author' })).toBeNull()
    expect(client.listMessages).not.toHaveBeenCalled()
  })

  it('opens the skill-author chat when it is requested explicitly and keeps it', async () => {
    const client = makeClient([STEWARD_OLD])
    mount(client, host)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(STEWARD_OLD.id, expect.anything()))
    act(() => requestOpenConversation(AUTHOR_NEW))
    expect(await screen.findByRole('complementary', { name: 'Skill author' })).toBeTruthy()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('complementary', { name: 'Skill author' })).toBeTruthy()
  })

  it('"Back to Central chat" selects the latest steward chat', async () => {
    const client = makeClient([STEWARD_OLD])
    mount(client, host)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(STEWARD_OLD.id, expect.anything()))
    act(() => requestOpenConversation(AUTHOR_NEW))
    const banner = await screen.findByRole('complementary', { name: 'Skill author' })
    fireEvent.click(within(banner).getByRole('button', { name: 'Back to Central chat' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Skill author' })).toBeNull())
    expect(client.createConversation).not.toHaveBeenCalled()
  })

  it('"Back to Central chat" starts a new steward chat when none exists', async () => {
    const client = makeClient([AUTHOR_NEW])
    mount(client, host)
    await screen.findByText(/No Central chat yet/)
    act(() => requestOpenConversation(AUTHOR_NEW))
    const banner = await screen.findByRole('complementary', { name: 'Skill author' })
    fireEvent.click(within(banner).getByRole('button', { name: 'Back to Central chat' }))
    await waitFor(() => expect(client.createConversation).toHaveBeenCalledWith())
  })

  it('New chat creates a plain chat (no mode) even while a skill-author chat is open', async () => {
    const client = makeClient([STEWARD_OLD])
    mount(client, host)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(STEWARD_OLD.id, expect.anything()))
    act(() => requestOpenConversation(AUTHOR_NEW))
    await screen.findByRole('complementary', { name: 'Skill author' })
    fireEvent.click(within(host).getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(client.createConversation).toHaveBeenCalledWith())
  })
})
