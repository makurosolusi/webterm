/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import BottomPanelHost, { revealBottomView, toggleBottomView, type BottomPanelView } from './bottomPanelHost'
import ChatPanel from './ChatPanel'
import type { ChatClient, ChatConversation, ChatStreamOptions } from './chat/chatTypes'
import type { StreamFactory } from './chat/chatConversation'


const GLOBAL: ChatConversation = {
  id: 'central:global', scope: 'global', projectId: null, activeTurnId: null,
  lastEventSeq: 0, lastMessageSeq: 0, updatedAt: 10, title: null,
}

/** A stand-in pane (the bottom panel's own views need a workspace): counts mounts, owns one action. */
function NotesPane(props: { host: HTMLElement | null; onMount: () => void }): React.JSX.Element {
  useEffect(() => props.onMount(), [])
  return (
    <>
      {props.host && createPortal(<button type="button" aria-label="Refresh notes" />, props.host)}
      <p>Deploy main</p>
    </>
  )
}

function makeChatClient(): ChatClient {
  return {
    listConversations: vi.fn(async () => ({ items: [GLOBAL], nextOffset: null })),
    createConversation: vi.fn(async () => GLOBAL),
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
  revealBottomView(null)
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

interface HarnessProps {
  onMountNotes: () => void
  chat: ChatClient
  factory: StreamFactory
  onCloseInbox?: () => void
  onCloseChat?: () => void
  initial?: { inbox: boolean; chat: boolean }
}

/** The host's wiring in miniature: a Notes pane and Chat as views of one host, toggled from outside. */
function Harness(props: HarnessProps) {
  const [inboxOpen, setInboxOpen] = useState(props.initial?.inbox ?? false)
  const [chatOpen, setChatOpen] = useState(props.initial?.chat ?? false)
  const closeInbox = () => { props.onCloseInbox?.(); setInboxOpen(false) }
  const closeChat = () => { props.onCloseChat?.(); setChatOpen(false) }
  const views: BottomPanelView[] = [
    {
      id: 'inbox', label: 'Notes', open: inboxOpen, onClose: closeInbox,
      render: (host) => <NotesPane host={host} onMount={props.onMountNotes} />,
    },
    {
      id: 'chat', label: 'Chat', open: chatOpen, onClose: closeChat,
      render: (host) => <ChatPanel open embedded actionsHost={host} client={props.chat} streamFactory={props.factory} onClose={closeChat} />,
    },
  ]
  return (
    <>
      <button onClick={() => toggleBottomView('inbox', inboxOpen, setInboxOpen)}>toggle-inbox</button>
      <button onClick={() => toggleBottomView('chat', chatOpen, setChatOpen)}>toggle-chat</button>
      <BottomPanelHost views={views} />
    </>
  )
}

function mount(extra: Partial<HarnessProps> = {}) {
  const inbox = { mounts: vi.fn() }
  const streams = makeStreams()
  const view = render(<Harness onMountNotes={inbox.mounts} chat={makeChatClient()} factory={streams.factory} {...extra} />)
  return { inbox, streams, ...view }
}

const visiblePanes = () => [...document.querySelectorAll('.vscode-bottom-panel__pane')].filter((el) => !el.hasAttribute('hidden'))
const panelTabs = () => within(screen.getByRole('tablist', { name: 'Panel tabs' })).getAllByRole('tab')
const selectedTab = () => panelTabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent

describe('BottomPanelHost', () => {
  it('opening Chat then Notes keeps ONE surface and ONE visible pane; the newest tab is selected', async () => {
    mount()
    expect(document.querySelector('.vscode-bottom-panel')).toBeNull()

    fireEvent.click(screen.getByText('toggle-chat'))
    expect(await screen.findByLabelText('Message the central agent')).not.toBeNull()
    expect(selectedTab()).toMatch(/^Chat/)

    fireEvent.click(screen.getByText('toggle-inbox'))
    expect(document.querySelectorAll('.vscode-bottom-panel')).toHaveLength(1)
    expect(panelTabs().map((t) => t.textContent)).toEqual([expect.stringMatching(/^Notes/), expect.stringMatching(/^Chat/)])
    expect(selectedTab()).toMatch(/^Notes/)
    expect(visiblePanes()).toHaveLength(1)
    expect(await screen.findByText('Deploy main')).not.toBeNull()
  })

  it('shows a single toolbar: only the active view contributes its actions', async () => {
    mount({ initial: { inbox: true, chat: true } })
    await screen.findByText('Deploy main')
    expect(screen.getAllByRole('toolbar')).toHaveLength(1)
    expect(screen.getByLabelText('Refresh notes')).not.toBeNull()
    expect(screen.queryByLabelText('Refresh conversations')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /^Chat/ }))
    expect(screen.getByLabelText('Refresh conversations')).not.toBeNull()
    expect(screen.queryByLabelText('Refresh notes')).toBeNull()
    expect(screen.getAllByLabelText('Close Panel')).toHaveLength(1)
  })

  it('keeps views mounted: switching tabs does not remount a pane or reopen the stream', async () => {
    const { inbox, streams } = mount({ initial: { inbox: true, chat: true } })
    await waitFor(() => expect(streams.opened).toHaveLength(1))
    fireEvent.click(screen.getByRole('tab', { name: /^Chat/ }))
    expect(await screen.findByLabelText('Message the central agent')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^Notes/ }))
    expect(inbox.mounts).toHaveBeenCalledTimes(1)
    expect(streams.opened).toHaveLength(1)
  })

  it('Dock toggle on a view open behind another tab reveals it; on the shown tab it closes it', async () => {
    mount({ initial: { inbox: true, chat: true } })
    await screen.findByText('Deploy main')
    expect(selectedTab()).toMatch(/^Notes/)
    fireEvent.click(screen.getByText('toggle-chat'))
    expect(selectedTab()).toMatch(/^Chat/)
    expect(panelTabs()).toHaveLength(2)
    fireEvent.click(screen.getByText('toggle-chat'))
    expect(panelTabs()).toHaveLength(1)
    expect(selectedTab()).toMatch(/^Notes/)
  })

  it('closes one view from its tab; Close Panel closes every open view', async () => {
    const onCloseInbox = vi.fn()
    const onCloseChat = vi.fn()
    mount({ initial: { inbox: true, chat: true }, onCloseInbox, onCloseChat })
    fireEvent.click(await screen.findByRole('button', { name: 'Close Notes' }))
    expect(onCloseInbox).toHaveBeenCalledTimes(1)
    expect(onCloseChat).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Close Panel'))
    expect(onCloseChat).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.vscode-bottom-panel')).toBeNull()
  })

  it('Chat composer and the scroll area live in the same pane of the panel, composer after the log', async () => {
    mount({ initial: { inbox: false, chat: true } })
    const composer = await screen.findByLabelText('Message the central agent')
    const pane = composer.closest('.vscode-bottom-panel__pane')!
    const log = pane.querySelector('.chat-thread')!
    expect(pane.closest('.vscode-bottom-panel__body')).not.toBeNull()
    expect(log.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(composer.closest('.chat-conversation')).toBe(log.closest('.chat-conversation'))
  })

  it('"Jump to bottom" renders inside the scroll wrapper and is not absolutely positioned', async () => {
    const dims = { scrollHeight: 1000, clientHeight: 100 }
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(dims.scrollHeight)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(dims.clientHeight)
    mount({ initial: { inbox: false, chat: true } })
    await screen.findByLabelText('Message the central agent')
    const log = document.querySelector('.chat-thread')!
    await act(async () => { log.scrollTop = 0; fireEvent.scroll(log) })
    const jump = screen.getByRole('button', { name: /Jump to bottom/ })
    expect(jump.closest('.chat-thread-wrap')).not.toBeNull()
    expect(jump.closest('.chat-thread')).toBeNull()
    const css = readFileSync('src/client/chat/chat.css', 'utf8')
    const rule = css.slice(css.indexOf('.chat-jump {'), css.indexOf('}', css.indexOf('.chat-jump {')))
    expect(rule).not.toMatch(/position:\s*absolute/)
  })

  it('no stylesheet still stacks or offsets a second panel', () => {
    const css = readFileSync('src/client/inboxPanelSurface.css', 'utf8')
    expect(css).not.toContain('above-inbox')
    expect(css).not.toMatch(/!important/)
  })
})
