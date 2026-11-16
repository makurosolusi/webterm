// Chat pane for the central agent (RND/11 §3), rendered in the secondary side bar on the right.
// Standalone it owns a single-tab surface; `App.secondarySideBar.tsx` is the shared tabbed mount.
// Mounted by App, opened by the Dock button or ⌥⌘B, never a canvas node. Props-driven; the default client is the
// module `chatApi` so production wiring is one prop-free mount.
//
// S0 scope: conversation list (global, extra chats, project scopes), Markdown thread, streaming text,
// composer with Stop, reconnect status, and error states. "New chat" (+) creates a fresh conversation
// like Copilot Chat; switching away from a running turn leaves it running on the server (Copilot keeps it too). Approval cards are intentionally absent;
// a tool card shows name/state only.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { IconTooltip } from '@/components/ui/icon-button'
import ChatConversationView, { type StreamFactory } from './chat/chatConversation'
import { clearOpenRequest, refresh, upsertConversation, useChatFeed, watchConversation } from './chat/chatFeed'
import { ChatConversationList } from './chat/chatConversationList'
import { NeedsYouStrip } from './chat/needsYouStrip'
import type { ChatClient } from './chat/chatTypes'
import { conversationLabel } from './chat/chatTypes'
import { chatApi, chatErrorMessage, openChatStream } from './chatApi'
import { InboxPanelSurface } from './inboxPanelSurface'
import './chat/chat.css'

const SELECTED_KEY = 'webterm.chatConversation'

function readSelected(): string | null {
  try {
    const value = localStorage.getItem(SELECTED_KEY)
    return value !== null && value !== '' ? value : null
  } catch {
    return null
  }
}

function persistSelected(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(SELECTED_KEY)
    else localStorage.setItem(SELECTED_KEY, id)
  } catch {
    // Private mode: selection is not remembered.
  }
}

export interface ChatPanelProps {
  /** Default true; App owns it via the side bar store. Closed = render nothing. */
  open?: boolean
  onClose?: () => void
  /** API implementation. Must be referentially stable (module default is). */
  client?: ChatClient
  /** SSE opener; injected in tests. */
  streamFactory?: StreamFactory
  /** Render only the pane body: the shared bottom-panel host owns the surface and tabs. */
  embedded?: boolean
  /** Embedded only: host toolbar slot while this pane is the active tab; null while hidden. */
  actionsHost?: HTMLElement | null
  /** Narrow host (side bar): the conversation list sits behind a History toggle instead of a column. */
  compact?: boolean
  /** The Central control panel is on: `/status`, `/halt`… and skills join the `/` menu. */
  centralEnabled?: boolean
}

export default function ChatPanel(props: ChatPanelProps) {
  const open = props.open ?? true
  const clientRef = useRef<ChatClient>(props.client ?? chatApi)
  clientRef.current = props.client ?? chatApi
  const streamRef = useRef<StreamFactory>(props.streamFactory ?? openChatStream)
  streamRef.current = props.streamFactory ?? openChatStream

  const feed = useChatFeed(clientRef.current, open)
  const conversations = feed.rows
  const [selected, setSelected] = useState<string | null>(readSelected)
  const [history, setHistory] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // The chat just created by "New chat": its composer takes focus once.
  const [fresh, setFresh] = useState<string | null>(null)
  // Set when the remembered conversation vanished and the panel moved to another one: told once, not silently.
  const [moved, setMoved] = useState<string | null>(null)

  const select = (id: string): void => { setSelected(id); setMoved(null) }

  // The remembered id is gone (first load only: later polls merge, never drop): fall back, and say so.
  useEffect(() => {
    if (conversations === null || (selected !== null && conversations.some((row) => row.id === selected))) return
    const fallback = conversations[0] ?? null
    setSelected(fallback?.id ?? null)
    setMoved(fallback && selected !== null ? `That conversation is no longer available. Showing ${conversationLabel(fallback)}.` : null)
  }, [conversations, selected])

  // An OS banner click asked for a conversation.
  useEffect(() => {
    if (feed.openRequest === null || conversations === null) return
    if (conversations.some((row) => row.id === feed.openRequest)) select(feed.openRequest)
    clearOpenRequest()
  }, [feed.openRequest, conversations])

  // Watching = selected, panel visible (not a hidden tab, not behind History) and open; the feed adds window focus.
  const compactMode = props.compact === true
  const visible = open && props.actionsHost !== null && !(compactMode && history)
  useEffect(() => {
    watchConversation(visible ? selected : null)
    return () => watchConversation(null)
  }, [visible, selected])

  useEffect(() => {
    if (!open) return
    persistSelected(selected)
  }, [open, selected])

  if (!open) return null

  const newChat = (): void => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    clientRef.current.createConversation().then(
      (row) => {
        setCreating(false)
        upsertConversation(row)
        setSelected(row.id)
        setFresh(row.id)
        setHistory(false)
      },
      (error: unknown) => {
        setCreating(false)
        setCreateError(`Could not start a new chat: ${chatErrorMessage(error)}`)
      }
    )
  }

  const newChatButton = (
    <IconTooltip label={creating ? 'Starting a new chat…' : 'New chat'}>
      <button type="button" className="vscode-panel-action" aria-label="New chat" aria-busy={creating || undefined}
        disabled={creating} onClick={newChat}>
        <span className="codicon codicon-add" aria-hidden="true" />
      </button>
    </IconTooltip>
  )
  const current = conversations?.find((row) => row.id === selected) ?? null
  const compact = compactMode
  const repliedRows = feed.replied.flatMap((id) => conversations?.find((row) => row.id === id) ?? [])
  const historyLabel = history ? 'Back to the conversation' : `Show conversations${current ? ` (current: ${conversationLabel(current)})` : ''}`
  const unreadCount = feed.unread.size
  const historyButton = compact && (
    <IconTooltip label={unreadCount > 0 ? `${historyLabel}, ${unreadCount} unread` : historyLabel}>
      <button type="button" className="vscode-panel-action chat-history-button"
        aria-label={unreadCount > 0 ? `Show conversations, ${unreadCount} unread` : 'Show conversations'} aria-pressed={history}
        onClick={() => setHistory((shown) => !shown)}>
        <span className="codicon codicon-history" aria-hidden="true" />
        {unreadCount > 0 && <span className="chat-history-button__badge" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
    </IconTooltip>
  )

  const body = (
    <>
      {feed.error !== null && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{feed.error}</span>
          <button type="button" className="chat-error__retry"
            onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {createError !== null && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{createError}</span>
          <button type="button" className="chat-error__retry" onClick={newChat}>Retry</button>
          <IconTooltip label="Dismiss error">
            <button type="button" className="chat-error__dismiss" aria-label="Dismiss error"
              onClick={() => setCreateError(null)}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </IconTooltip>
        </div>
      )}

      {/* Always mounted so the announcement is read; one line however many replies landed. */}
      <div className="chat-live" role="status" aria-live="polite">
        {moved !== null && (
          <div className="chat-notice chat-notice--info chat-live__line">
            <span className="chat-notice__text">{moved}</span>
            <IconTooltip label="Dismiss notice">
              <button type="button" className="chat-error__dismiss" aria-label="Dismiss notice" onClick={() => setMoved(null)}>
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </IconTooltip>
          </div>
        )}
        {repliedRows.length > 0 && (
          <div className="chat-notice chat-notice--info chat-live__line">
            <span className="chat-notice__text">
              {`Central replied in ${conversationLabel(repliedRows[0]!)}${repliedRows.length > 1 ? ` and ${repliedRows.length - 1} more` : ''}`}
            </span>
            <button type="button" className="chat-error__retry" onClick={() => { select(repliedRows[0]!.id); setHistory(false) }}>Open</button>
          </div>
        )}
      </div>
      <NeedsYouStrip />
      <div className={cn('chat-body', compact && 'chat-body--compact')}>
        {(!compact || history) && <ChatConversationList conversations={conversations} feed={feed} selected={selected}
          onPick={(id) => { select(id); setHistory(false) }} />}

        {/* Hidden, not unmounted, behind History: the stream and the composer draft survive. */}
        <div className="chat-main" hidden={compact && history}>
          {current ? (
            <ChatConversationView
              key={current.id}
              conversation={current}
              client={clientRef.current}
              streamFactory={streamRef.current}
              focusComposer={current.id === fresh}
              commands={{ centralEnabled: props.centralEnabled === true, newChat, showHistory: () => setHistory(true) }}
            />
          ) : (
            conversations !== null && (
              <p className="chat-empty">
                {conversations.length === 0 ? 'No conversations yet.' : 'Select a conversation to start.'}
              </p>
            )
          )}
        </div>
      </div>
    </>
  )

  if (props.embedded) {
    return (
      <div className="chat-panel chat-panel--embedded">
        {props.actionsHost && createPortal(<>{newChatButton}{historyButton}</>, props.actionsHost)}
        {body}
      </div>
    )
  }

  return (
    <InboxPanelSurface
      className="chat-panel"
      ariaLabel="Chat"
      tabsLabel="Chat tabs"
      tabs={[{
        id: 'chat',
        label: 'Chat',
        tooltip: 'Central agent',
        closable: props.onClose !== undefined,
      }]}
      activeId="chat"
      onActivate={() => undefined}
      {...(props.onClose === undefined ? {} : { onClose: () => props.onClose?.(), onClosePanel: () => props.onClose?.() })}
      actions={newChatButton}
    >
      {body}
    </InboxPanelSurface>
  )
}
