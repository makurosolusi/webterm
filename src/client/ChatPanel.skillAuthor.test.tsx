/** @vitest-environment jsdom */
// The Skills tab hands a freshly created skill-author conversation to the mounted Central chat: it is selected, listed as
// "Skill author" and shows the role banner.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from './ChatPanel'
import { requestOpenConversation } from './chat/chatFeed'
import type { StreamFactory } from './chat/chatConversation'
import type { ChatClient, ChatConversation } from './chat/chatTypes'

const GLOBAL: ChatConversation = { id: 'central:global', scope: 'global', projectId: null, activeTurnId: null, lastEventSeq: 1, lastMessageSeq: 1, updatedAt: 5, title: 'Old question' }
const AUTHOR: ChatConversation = { id: 'central:chat:author', scope: 'chat:author', projectId: null, activeTurnId: null, lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 9, title: null, mode: 'skill-author', skillTarget: 'webterm-rule' }
const streams: StreamFactory = () => ({ close: () => {} })

let host: HTMLElement
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
})
afterEach(() => { cleanup(); host.remove(); vi.unstubAllGlobals(); localStorage.clear() })

describe('Central chat opened for the skill author', () => {
  it('selects the new author conversation, shows its banner and labels it Skill author in History', async () => {
    const client: ChatClient = {
      listConversations: vi.fn(async () => ({ items: [GLOBAL], nextOffset: null })),
      createConversation: vi.fn(),
      listMessages: vi.fn(async () => []),
      sendMessage: vi.fn(), cancelTurn: vi.fn(),
    }
    render(<ChatPanel open embedded compact actionsHost={host} centralEnabled client={client} streamFactory={streams} />)
    await waitFor(() => expect(client.listMessages).toHaveBeenCalledWith(GLOBAL.id, expect.anything()))
    expect(screen.queryByRole('complementary', { name: 'Skill author' })).toBeNull()

    act(() => requestOpenConversation(AUTHOR))
    expect(await screen.findByRole('complementary', { name: 'Skill author' })).toBeTruthy()
    expect(screen.getByText('Editing webterm-rule.')).toBeTruthy()
    expect(localStorage.getItem('webterm.chatConversation')).toBe(AUTHOR.id)

    fireEvent.click(within(host).getByRole('button', { name: 'Show conversations' }))
    const list = screen.getByRole('navigation', { name: 'Conversations' })
    expect(within(list).getByRole('button', { name: /Skill author: webterm-rule/ })).toBeTruthy()
  })
})
