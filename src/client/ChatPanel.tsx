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
import { NeedsYouStrip } from './chat/needsYouStrip'
import type { ChatClient, ChatConversation } from './chat/chatTypes'
import { conversationLabel } from './chat/chatTypes'
import { chatApi, chatErrorMessage, isAbortError, openChatStream } from './chatApi'
import { InboxPanelSurface } from './inboxPanelSurface'
import { relativeTime } from './SessionHistory.model'
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

  const [conversations, setConversations] = useState<ChatConversation[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // Terpisah dari `conversations === null`: setelah gagal muat daftar juga masih null, dan "Loading…"
  // tidak boleh tampil di samping banner error.
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(readSelected)
  const [refreshKey, setRefreshKey] = useState(0)
  const [history, setHistory] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // The chat just created by "New chat": its composer takes focus once.
  const [fresh, setFresh] = useState<string | null>(null)
  // History paging: offset of the next older page (null = none), and the Show more request state.
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [more, setMore] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setListError(null)
    setLoading(true)
    clientRef.current.listConversations({ signal: controller.signal }).then(
      ({ items: rows, nextOffset: next }) => {
        if (controller.signal.aborted) return
        setLoading(false)
        setConversations(rows)
        setNextOffset(next)
        setMore({ loading: false, error: null })
        setSelected((current) => {
          if (current !== null && rows.some((row) => row.id === current)) return current
          return rows[0]?.id ?? null
        })
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setLoading(false)
        setListError(chatErrorMessage(error))
      }
    )
    return () => controller.abort()
  }, [open, refreshKey])

  useEffect(() => {
    if (!open) return
    persistSelected(selected)
  }, [open, selected])

  if (!open) return null

  const showMore = (): void => {
    if (nextOffset === null || more.loading) return
    setMore({ loading: true, error: null })
    clientRef.current.listConversations({ offset: nextOffset }).then(
      ({ items, nextOffset: next }) => {
        setConversations((rows) => {
          const known = new Set((rows ?? []).map((row) => row.id))
          return [...(rows ?? []), ...items.filter((row) => !known.has(row.id))]
        })
        setNextOffset(next)
        setMore({ loading: false, error: null })
      },
      (error: unknown) => setMore({ loading: false, error: `Could not load more: ${chatErrorMessage(error)}` })
    )
  }

  const newChat = (): void => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    clientRef.current.createConversation().then(
      (row) => {
        setCreating(false)
        setConversations((rows) => [row, ...(rows ?? []).filter((other) => other.id !== row.id)])
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
  const compact = props.compact === true
  const historyLabel = history ? 'Back to the conversation' : `Show conversations${current ? ` (current: ${conversationLabel(current)})` : ''}`
  const historyButton = compact && (
    <IconTooltip label={historyLabel}>
      <button type="button" className="vscode-panel-action" aria-label="Show conversations" aria-pressed={history}
        onClick={() => setHistory((shown) => !shown)}>
        <span className="codicon codicon-history" aria-hidden="true" />
      </button>
    </IconTooltip>
  )

  const body = (
    <>
      {listError !== null && (
        <div className="chat-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{listError}</span>
          <button type="button" className="chat-error__retry"
            onClick={() => setRefreshKey((key) => key + 1)}>
            Retry
          </button>
          <IconTooltip label="Dismiss error">
            <button type="button" className="chat-error__dismiss" aria-label="Dismiss error"
              onClick={() => setListError(null)}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </IconTooltip>
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

      <NeedsYouStrip />
      <div className={cn('chat-body', compact && 'chat-body--compact')}>
        {(!compact || history) && <nav className="chat-conversations" aria-label="Conversations">
          {conversations === null ? (
            loading && <p className="chat-list-status">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="chat-list-status">No conversations yet</p>
          ) : (
            <ul className="chat-list">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={cn('chat-list-item', conversation.id === selected && 'is-active')}
                    aria-current={conversation.id === selected ? 'true' : undefined}
                    onClick={() => { setSelected(conversation.id); setHistory(false) }}
                  >
                    <span className="chat-list-item__label">{conversationLabel(conversation)}</span>
                    {conversation.updatedAt > 0 && (
                      <span className="chat-list-item__time">{relativeTime(conversation.updatedAt)}</span>
                    )}
                    {conversation.activeTurnId !== null && (
                      <span className="chat-list-item__live" title="Turn running" aria-label="Turn running" />
                    )}
                  </button>
                </li>
              ))}
              {nextOffset !== null && (
                <li className="chat-list-more">
                  {more.error !== null && <p className="chat-list-status" role="alert">{more.error}</p>}
                  <button type="button" className="chat-list-item" disabled={more.loading}
                    aria-busy={more.loading || undefined} onClick={showMore}>
                    <span className="chat-list-item__label">
                      {more.loading ? 'Loading…' : more.error !== null ? 'Retry' : 'Show more'}
                    </span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </nav>}

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
