// Chat pane for the central agent (RND/11 §3), rendered in the VS Code bottom panel. Standalone
// it owns a single-tab surface; `bottomPanelHost.tsx` is the shared tabbed mount. Mounted by
// App, opened by the Dock button, never a canvas node. Props-driven; the default client is the
// module `chatApi` so production wiring is one prop-free mount.
//
// S0 scope: conversation list (global + project scopes), Markdown thread, streaming text,
// composer with Stop, reconnect status, and error states. Approval cards are intentionally absent;
// a tool card shows name/state only.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { IconTooltip } from '@/components/ui/icon-button'
import ChatConversationView, { type StreamFactory } from './chat/chatConversation'
import type { ChatClient, ChatConversation } from './chat/chatTypes'
import { conversationLabel } from './chat/chatTypes'
import { chatApi, chatErrorMessage, isAbortError, openChatStream } from './chatApi'
import { InboxPanelSurface } from './inboxPanelSurface'
import './chat/chat.css'

const OPEN_KEY = 'webterm.chatOpen'
const SELECTED_KEY = 'webterm.chatConversation'

/** Open/closed state for the Dock toggle, persisted per browser. Closed on first run. */
export function useChatOpen(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // Private mode: the choice lasts for this tab only.
    }
  }, [open])
  return [open, setOpen] as const
}

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
  /** Default true; App owns it via `useChatOpen`. Closed = render nothing. */
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

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setListError(null)
    setLoading(true)
    clientRef.current.listConversations({ signal: controller.signal }).then(
      (rows) => {
        if (controller.signal.aborted) return
        setLoading(false)
        setConversations(rows)
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

  const refreshButton = (
    <IconTooltip label="Refresh conversations">
      <button type="button" className="vscode-panel-action" aria-label="Refresh conversations"
        onClick={() => setRefreshKey((key) => key + 1)}>
        <span className="codicon codicon-refresh" aria-hidden="true" />
      </button>
    </IconTooltip>
  )
  const current = conversations?.find((row) => row.id === selected) ?? null

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

      <div className="chat-body">
        <nav className="chat-conversations" aria-label="Conversations">
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
                    onClick={() => setSelected(conversation.id)}
                  >
                    <span className="chat-list-item__label">{conversationLabel(conversation)}</span>
                    {conversation.activeTurnId !== null && (
                      <span className="chat-list-item__live" title="Turn running" aria-label="Turn running" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="chat-main">
          {current ? (
            <ChatConversationView
              key={current.id}
              conversation={current}
              client={clientRef.current}
              streamFactory={streamRef.current}
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
        {props.actionsHost && createPortal(refreshButton, props.actionsHost)}
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
      actions={refreshButton}
    >
      {body}
    </InboxPanelSurface>
  )
}
